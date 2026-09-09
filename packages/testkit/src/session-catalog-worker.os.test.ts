import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  createCodingToolRegistry,
  createJsonlSessionStoreDirectory,
  createPermissionPolicy,
  type ProjectSessionCatalogController,
  type ProjectSessionCatalogSnapshot,
  type SessionLifecycle,
  SessionLifecycleError,
  SessionStoreError,
} from "@adam-agent/agent";
import {
  createTrustedWorkspaceTrustForTesting,
  sessionCatalogWorkerFactory,
  sessionStoreDirectory,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";
import {
  createSessionLifecycle,
  settledModelTargets,
  targetIdentity,
} from "./presentation-session.test-support.js";

function observeCatalog(lifecycle: SessionLifecycle, limit = 100) {
  const updates: ProjectSessionCatalogSnapshot[] = [];
  const listeners = new Set<(snapshot: ProjectSessionCatalogSnapshot) => void>();
  const controller = lifecycle.startProjectSessionCatalog({
    limit,
    onUpdate(snapshot) {
      updates.push(snapshot);
      for (const listener of listeners) listener(snapshot);
    },
  });
  return {
    controller,
    updates,
    async until(predicate: (snapshot: ProjectSessionCatalogSnapshot) => boolean) {
      const existing = updates.find(predicate);
      if (existing !== undefined) return existing;
      if (updates.some((snapshot) => snapshot.phase === "failed")) {
        throw new Error("The native catalog failed before the requested state.");
      }
      const pending = Promise.withResolvers<ProjectSessionCatalogSnapshot>();
      const listener = (snapshot: ProjectSessionCatalogSnapshot) => {
        if (predicate(snapshot)) pending.resolve(snapshot);
        else if (snapshot.phase === "failed") {
          pending.reject(new Error("The native catalog failed before the requested state."));
        }
      };
      listeners.add(listener);
      try {
        return await withManagedFailureGuard(pending.promise, "the requested native catalog state");
      } finally {
        listeners.delete(listener);
      }
    },
  };
}

test("native background summaries paginate before full health and converge to the strict catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-catalog-worker-pages-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  const author = createSessionLifecycle({
    workspaceRoot,
    stateRoot,
    modelTargets: settledModelTargets(),
  });
  const trust = createTrustedWorkspaceTrustForTesting(workspaceRoot);
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const reader = createSessionLifecycle({
    workspaceRoot,
    stateRoot,
    workspaceTrust: {
      ...trust,
      async load() {
        requested.resolve();
        await release.promise;
        return trust.load();
      },
    },
  });
  let catalog: ReturnType<typeof observeCatalog> | undefined;
  try {
    for (const name of ["First history", "Second history", "Third history"]) {
      const session = await author.create({ targetIdentity });
      await author.continue({ sessionId: session.sessionId, input: { text: name } });
      await author.setSessionManualName({ sessionId: session.sessionId, name });
    }
    await author.create({ targetIdentity });
    const expected = await author.listProjectSessionSummaries();
    catalog = observeCatalog(reader, 1);
    const first = await catalog.until((snapshot) => snapshot.phase === "ready");
    expect(first.items).toEqual(expected.items.slice(0, 1));
    expect(first.health.status).not.toBe("complete");
    await withManagedFailureGuard(
      requested.promise,
      "the live authority request after summary publication",
    );
    if (first.nextCursor === null) throw new Error("Expected another summary page.");
    await catalog.controller.loadMore(first.nextCursor);
    const second = await catalog.until((snapshot) => snapshot.items.length === 2);
    expect(second.items).toEqual(expected.items.slice(0, 2));
    await expect(catalog.controller.loadMore(first.nextCursor)).rejects.toMatchObject({
      code: "session_invalid",
    });
    release.resolve();
    const complete = await catalog.until((snapshot) => snapshot.health.status === "complete");
    expect(complete.health).toEqual({ status: "complete", checked: 4, total: 4 });
    if (complete.nextCursor === null) throw new Error("Expected the remaining history page.");
    await catalog.controller.loadMore(complete.nextCursor);
    const final = await catalog.until(
      (snapshot) => snapshot.items.length === 3 && snapshot.nextCursor === null,
    );
    expect(final.items).toEqual(expected.items);
    expect(final.diagnostics).toEqual(expected.diagnostics);
  } finally {
    release.resolve();
    await catalog?.controller.close();
    await reader.close();
    await author.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("native full health uses the owning Lifecycle's exact built-in Todo authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-catalog-worker-plan-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  const tools = createCodingToolRegistry({ workspaceRoot, stateRoot });
  const author = createSessionLifecycle({
    workspaceRoot,
    stateRoot,
    tools,
    modelTargets: settledModelTargets(),
  });
  let reader: SessionLifecycle | undefined;
  let controller: ProjectSessionCatalogController | undefined;
  try {
    const session = await author.create({ targetIdentity });
    await author.continue({
      sessionId: session.sessionId,
      input: { text: "Keep the exact Todo Plan authority." },
    });
    await author.enterPlan({ sessionId: session.sessionId });
    const valid = observeCatalog(author);
    controller = valid.controller;
    const validComplete = await valid.until((snapshot) => snapshot.health.status === "complete");
    expect(validComplete.items.map((item) => item.sessionId)).toEqual([session.sessionId]);
    expect(validComplete.diagnostics.totalCount).toBe(0);
    await controller.close();
    reader = createSessionLifecycle({
      workspaceRoot,
      stateRoot,
      tools: {
        definitions: () => tools.definitions(),
        resolve(name) {
          const adapter = tools.resolve(name);
          // Same names, definitions and digests do not grant the built-in Todo identity.
          return adapter !== undefined &&
            ["create_todo", "update_todo", "update_todos"].includes(name)
            ? { ...adapter }
            : adapter;
        },
      },
    });
    const strict = await reader.listProjectSessions();
    expect(strict.items).toEqual([]);
    expect(strict.diagnostics).toMatchObject({
      totalCount: 1,
      items: [{ code: "invalid_history" }],
    });
    const invalid = observeCatalog(reader);
    controller = invalid.controller;
    const invalidComplete = await invalid.until(
      (snapshot) => snapshot.health.status === "complete",
    );
    expect(invalidComplete.items).toEqual([]);
    expect(invalidComplete.diagnostics).toEqual(strict.diagnostics);
  } finally {
    await controller?.close();
    await reader?.close();
    await author.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each([true, false])(
  "native full health keeps current MCP trust=%s and systemic failure semantics",
  async (trusted) => {
    const root = await mkdtemp(join(tmpdir(), "adam-catalog-worker-mcp-"));
    const workspaceRoot = join(root, "workspace");
    const stateRoot = join(root, "state");
    await mkdir(workspaceRoot);
    const author = createSessionLifecycle({
      workspaceRoot,
      stateRoot,
      modelTargets: settledModelTargets(),
    });
    const trust = createTrustedWorkspaceTrustForTesting(workspaceRoot);
    const reader = createSessionLifecycle({
      workspaceRoot,
      stateRoot,
      workspaceTrust: {
        ...trust,
        async load() {
          return { ...(await trust.load()), status: trusted ? "trusted" : "untrusted" };
        },
      },
    });
    let controller: ProjectSessionCatalogController | undefined;
    try {
      const session = await author.create({ targetIdentity });
      await author.continue({
        sessionId: session.sessionId,
        input: { text: "MCP inspection boundary" },
      });
      await writeFile(join(workspaceRoot, ".mcp.json"), "{invalid configuration");
      if (trusted)
        await expect(reader.listProjectSessions()).rejects.toMatchObject({
          code: "mcp_config_invalid",
        });
      else
        expect((await reader.listProjectSessions()).items.map((item) => item.sessionId)).toEqual([
          session.sessionId,
        ]);
      const catalog = observeCatalog(reader);
      controller = catalog.controller;
      const outcome = await catalog.until(
        (snapshot) => snapshot.health.status === (trusted ? "failed" : "complete"),
      );
      expect(outcome.diagnostics.totalCount).toBe(0);
      if (trusted) {
        expect(outcome).toMatchObject({
          phase: "failed",
          error: { code: "catalog_scan_failed" },
          health: { checked: 0, total: 1 },
        });
      } else {
        expect(outcome.items.map((item) => item.sessionId)).toEqual([session.sessionId]);
        expect(outcome.health).toEqual({ status: "complete", checked: 1, total: 1 });
      }
    } finally {
      await controller?.close();
      await reader.close();
      await author.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("native catalog close reclaims its worker while a read-only authority request is held", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-catalog-worker-close-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  const author = createSessionLifecycle({
    workspaceRoot,
    stateRoot,
    modelTargets: settledModelTargets(),
  });
  const trust = createTrustedWorkspaceTrustForTesting(workspaceRoot);
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  const reader = createSessionLifecycle({
    workspaceRoot,
    stateRoot,
    [sessionCatalogWorkerFactory](url, options) {
      const worker = new Worker(url, options);
      worker.once("exit", () => exited.resolve());
      return worker;
    },
    workspaceTrust: {
      ...trust,
      async load() {
        requested.resolve();
        await release.promise;
        return trust.load();
      },
    },
  });
  let catalog: ReturnType<typeof observeCatalog> | undefined;
  try {
    const session = await author.create({ targetIdentity });
    await author.continue({
      sessionId: session.sessionId,
      input: { text: "Close while health is pending." },
    });
    catalog = observeCatalog(reader);
    await catalog.until((snapshot) => snapshot.phase === "ready");
    await withManagedFailureGuard(requested.promise, "the held read-only authority request");
    await withManagedFailureGuard(
      reader.close(),
      "Lifecycle close with a held worker authority request",
    );
    await withManagedFailureGuard(exited.promise, "native history worker exit");
    expect(catalog.updates.some((snapshot) => snapshot.health.status === "complete")).toBe(false);
    await expect(catalog.controller.loadMore("closed")).rejects.toMatchObject({
      name: "AbortError",
    });
  } finally {
    release.resolve();
    await catalog?.controller.close();
    await reader.close();
    await author.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("native authority transport preserves the frozen isolation errors and fails on unknown errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-catalog-worker-authority-errors-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  const author = createSessionLifecycle({
    workspaceRoot,
    stateRoot,
    modelTargets: settledModelTargets(),
  });
  const trust = createTrustedWorkspaceTrustForTesting(workspaceRoot);
  try {
    const session = await author.create({ targetIdentity });
    await author.continue({
      sessionId: session.sessionId,
      input: { text: "Retain the authority error classification." },
    });
    for (const { error, code } of [
      { error: new SessionLifecycleError("session_invalid"), code: "invalid_history" },
      { error: new SessionStoreError("session_log_invalid"), code: "invalid_log" },
      { error: new SessionStoreError("session_log_too_large"), code: "log_too_large" },
      { error: new Error("External authority unavailable"), code: null },
    ]) {
      const reader = createSessionLifecycle({
        workspaceRoot,
        stateRoot,
        workspaceTrust: {
          ...trust,
          async load() {
            throw error;
          },
        },
      });
      const catalog = observeCatalog(reader);
      try {
        const outcome = await catalog.until(
          (snapshot) => snapshot.health.status === (code === null ? "failed" : "complete"),
        );
        if (code === null) {
          await expect(reader.listProjectSessions()).rejects.toBe(error);
          expect(outcome.error?.code).toBe("catalog_scan_failed");
          expect(outcome.diagnostics.totalCount).toBe(0);
        } else {
          expect(outcome.items).toEqual([]);
          expect(outcome.diagnostics).toMatchObject({
            totalCount: 1,
            items: [{ sessionId: session.sessionId, code, retained: true }],
          });
          expect(outcome.diagnostics).toEqual((await reader.listProjectSessions()).diagnostics);
        }
      } finally {
        await catalog.controller.close();
        await reader.close();
      }
    }
  } finally {
    await author.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("background health refresh reads changed native bytes and preserves isolated log diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-catalog-worker-refresh-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  const lifecycle = createSessionLifecycle({
    workspaceRoot,
    stateRoot,
    modelTargets: settledModelTargets(),
  });
  let controller: ProjectSessionCatalogController | undefined;
  try {
    const session = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({ sessionId: session.sessionId, input: { text: "Refresh catalog" } });
    await lifecycle.setSessionManualName({ sessionId: session.sessionId, name: "Before" });
    const first = observeCatalog(lifecycle);
    controller = first.controller;
    await first.until((snapshot) => snapshot.health.status === "complete");
    const path = join(
      stateRoot,
      "projects",
      session.projectId.replace(/^sha256:/u, ""),
      "sessions",
      `${session.sessionId}.jsonl`,
    );
    const original = await readFile(path, "utf8");
    const changed = original.replace('"name":"Before"', '"name":false   ');
    expect(changed).not.toBe(original);
    expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(original));
    await writeFile(path, changed);
    const refreshed = observeCatalog(lifecycle);
    controller = refreshed.controller;
    const complete = await refreshed.until((snapshot) => snapshot.health.status === "complete");
    expect(complete.items).toEqual([]);
    expect(complete.diagnostics).toMatchObject({
      totalCount: 1,
      items: [{ sessionId: session.sessionId, code: "invalid_log" }],
    });
    expect(complete.diagnostics).toEqual((await lifecycle.listProjectSessions()).diagnostics);
    await expect(lifecycle.inspect({ sessionId: session.sessionId })).rejects.toMatchObject({
      code: "session_log_invalid",
    });
  } finally {
    await controller?.close();
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["rename", "repair", "append", "delete"] as const)(
  "full health replaces provisional metadata after concurrent %s without losing page bounds",
  async (change) => {
    const root = await mkdtemp(join(tmpdir(), "adam-catalog-worker-convergence-"));
    const workspaceRoot = join(root, "workspace");
    const stateRoot = join(root, "state");
    await mkdir(workspaceRoot);
    const author = createSessionLifecycle({
      workspaceRoot,
      stateRoot,
      modelTargets: settledModelTargets(),
    });
    const trust = createTrustedWorkspaceTrustForTesting(workspaceRoot);
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let firstAuthorityRead = true;
    const reader = createSessionLifecycle({
      workspaceRoot,
      stateRoot,
      workspaceTrust: {
        ...trust,
        async load() {
          if (firstAuthorityRead) {
            firstAuthorityRead = false;
            requested.resolve();
            await release.promise;
          }
          return trust.load();
        },
      },
    });
    let catalog: ReturnType<typeof observeCatalog> | undefined;
    try {
      const sessions = [];
      for (const [index, name] of ["Gate", "Before", "Tail"].entries()) {
        const session = await author.create({ targetIdentity });
        await author.continue({
          sessionId: session.sessionId,
          input: { text: `Catalog observation ${index}` },
        });
        await author.setSessionManualName({ sessionId: session.sessionId, name });
        const path = join(
          stateRoot,
          "projects",
          session.projectId.replace(/^sha256:/u, ""),
          "sessions",
          `${session.sessionId}.jsonl`,
        );
        await utimes(path, 3_000 - index, 3_000 - index);
        sessions.push({ id: session.sessionId, path });
      }
      const target = sessions[1];
      if (target === undefined) throw new Error("Expected the second catalog fixture.");
      const original = await readFile(target.path, "utf8");
      if (change === "repair") {
        await writeFile(target.path, original.replace('"name":"Before"', '"name":false   '));
        await utimes(target.path, 2_999, 2_999);
      }
      catalog = observeCatalog(reader, 2);
      const provisional = await catalog.until((snapshot) => snapshot.phase === "ready");
      expect(provisional.items).toHaveLength(2);
      expect(provisional.diagnostics.totalCount).toBe(change === "repair" ? 1 : 0);
      await withManagedFailureGuard(
        requested.promise,
        "the first health entry before the changed history is read",
      );
      if (change === "delete") {
        await rm(target.path);
      } else if (change === "append") {
        await author.continue({ sessionId: target.id, input: { text: "A newly settled run." } });
        await author.setSessionManualName({ sessionId: target.id, name: "After!" });
      } else {
        const changed = original.replace('"name":"Before"', '"name":"After!"');
        expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(original));
        await writeFile(target.path, changed);
      }
      release.resolve();
      const complete = await catalog.until((snapshot) => snapshot.health.status === "complete");
      expect(complete.items).toHaveLength(2);
      expect(complete.diagnostics).toEqual({ items: [], totalCount: 0, truncated: false });
      expect(complete.health).toEqual({ status: "complete", checked: 3, total: 3 });
      if (change === "delete") {
        expect(complete.items.map((item) => item.sessionId)).toEqual([
          sessions[0]?.id,
          sessions[2]?.id,
        ]);
        expect(complete.nextCursor).toBeNull();
      } else {
        expect(complete.items.map((item) => item.sessionId)).toEqual([sessions[0]?.id, target.id]);
        const strict = (await author.listProjectSessionSummaries()).items.find(
          (item) => item.sessionId === target.id,
        );
        expect(complete.items.find((item) => item.sessionId === target.id)).toEqual(strict);
        expect(strict).toMatchObject({ naming: { manualName: "After!" } });
        if (complete.nextCursor === null)
          throw new Error("The tail row still needs a continuation page.");
        await catalog.controller.loadMore(complete.nextCursor);
        const next = await catalog.until((snapshot) => snapshot.items.length === 3);
        expect(next.items.map((item) => item.sessionId)).toEqual(
          sessions.map((session) => session.id),
        );
        expect(next.nextCursor).toBeNull();
      }
    } finally {
      release.resolve();
      await catalog?.controller.close();
      await reader.close();
      await author.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("a custom session store explicitly declines the native background scan without changing strict catalog access", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-catalog-worker-custom-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  const lifecycle = createSessionLifecycle({
    workspaceRoot,
    stateRoot,
    [sessionStoreDirectory]: createJsonlSessionStoreDirectory({ workspaceRoot, stateRoot }),
  });
  const catalog = observeCatalog(lifecycle);
  try {
    const unavailable = await catalog.until((snapshot) => snapshot.phase === "failed");
    expect(unavailable).toMatchObject({
      error: { code: "catalog_unavailable" },
      health: { status: "failed", checked: 0, total: null },
    });
    expect((await lifecycle.listProjectSessions()).items).toEqual([]);
  } finally {
    await catalog.controller.close();
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["ancestor", "artifact"] as const)(
  "full background health revalidates changed %s dependencies across generations",
  async (change) => {
    const root = await mkdtemp(join(tmpdir(), "adam-catalog-worker-lineage-"));
    const workspaceRoot = join(root, "workspace");
    const stateRoot = join(root, "state");
    const skillRoot = join(workspaceRoot, ".agents", "skills", "catalog-check");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      join(skillRoot, "SKILL.md"),
      "---\nname: catalog-check\ndescription: Check retained catalog evidence.\n---\nKeep the recorded procedure.\n",
    );
    const lifecycle = createSessionLifecycle({
      workspaceRoot,
      stateRoot,
      modelTargets: settledModelTargets(),
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    });
    let controller: ProjectSessionCatalogController | undefined;
    try {
      const parent = await lifecycle.create({ targetIdentity });
      const activated = await lifecycle.continue({
        sessionId: parent.sessionId,
        input: {
          text: "Record the selected procedure.",
          skills: ["skill:v1:project:.:catalog-check"],
        },
      });
      expect(activated.snapshot.skillContext?.active).toEqual([
        expect.objectContaining({ qualifiedId: "skill:v1:project:.:catalog-check" }),
      ]);
      const named = await lifecycle.setSessionManualName({
        sessionId: parent.sessionId,
        name: "Before",
      });
      const child = await lifecycle.branch({
        parentSessionId: parent.sessionId,
        atSequence: named.snapshot.lastSequence,
      });
      await lifecycle.continue({
        sessionId: child.sessionId,
        input: { text: "Use the inherited procedure." },
      });
      const initial = observeCatalog(lifecycle);
      controller = initial.controller;
      const healthy = await initial.until((snapshot) => snapshot.health.status === "complete");
      expect(healthy.diagnostics.totalCount).toBe(0);
      expect(healthy.items).toHaveLength(2);
      await controller.close();
      if (change === "ancestor") {
        const path = join(
          stateRoot,
          "projects",
          parent.projectId.replace(/^sha256:/u, ""),
          "sessions",
          `${parent.sessionId}.jsonl`,
        );
        const before = await readFile(path, "utf8");
        const after = before.replace('"name":"Before"', '"name":"After!"');
        expect(after).not.toBe(before);
        expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
        await writeFile(path, after);
      } else {
        const records = await createJsonlSessionStoreDirectory({
          workspaceRoot,
          stateRoot,
        }).readRecords?.(parent.sessionId);
        const activation = records?.find(
          (record) =>
            record.schemaVersion === 3 && record.record.type === "skill_activation_batch_committed",
        );
        if (
          activation?.schemaVersion !== 3 ||
          activation.record.type !== "skill_activation_batch_committed"
        ) {
          throw new Error("Expected the retained Skill activation.");
        }
        const artifact = activation.record.skillContext.active[0]?.artifact;
        if (artifact === undefined) throw new Error("Expected the retained Skill artifact.");
        await rm(join(stateRoot, "artifacts", artifact.id.slice("sha256:".length)));
      }
      const strict = await lifecycle.listProjectSessionSummaries();
      expect(strict.diagnostics.totalCount).toBe(change === "ancestor" ? 1 : 2);
      const refreshed = observeCatalog(lifecycle);
      controller = refreshed.controller;
      const complete = await refreshed.until((snapshot) => snapshot.health.status === "complete");
      expect(complete.items).toEqual(strict.items);
      expect(complete.diagnostics).toEqual(strict.diagnostics);
      expect(complete.health).toEqual({ status: "complete", checked: 2, total: 2 });
    } finally {
      await controller?.close();
      await lifecycle.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
