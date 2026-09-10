import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPermissionPolicy,
  createPresentationSession,
  createProductionManagedControlComposition,
} from "@adam-agent/agent";
import {
  createRecoverableTurnDraftRepository,
  sessionDraftMutation,
  sessionManagedControl,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { FakeModelDriver } from "./index.js";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";
import {
  createSessionLifecycleForTests,
  modelTargetsWithDriver,
  sessionLifecycleTargetIdentity as targetIdentity,
} from "./session-lifecycle.test-support.js";

test("Lifecycle Trash restores Todo, canonical artifacts and draft resources only after the complete unit validates", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-trash-lifecycle-"));
  const workspaceRoot = join(root, "project");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  const resource = "Immutable source bytes for restored history.\n";
  const selectedPath = join(workspaceRoot, "evidence.txt");
  await writeFile(selectedPath, resource);
  let calls = 0;
  const modelTargets = modelTargetsWithDriver(
    new FakeModelDriver(() =>
      ++calls === 1
        ? [
            { type: "tool_call_start", id: "todo", name: "create_todo" },
            { type: "tool_call_delta", id: "todo", json: '{"title":"Restore this Todo"}' },
            { type: "tool_call_end", id: "todo" },
            { type: "finish", reason: "tool_calls" },
          ]
        : [
            { type: "text_delta", text: "Retained Main answer." },
            { type: "finish", reason: "stop" },
          ],
    ),
  );
  const options = {
    workspaceRoot,
    stateRoot,
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read", "write"] }),
  };
  let lifecycle = createSessionLifecycleForTests(options);
  let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;
  try {
    const main = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: main.sessionId,
      input: { text: "Keep the Todo and source" },
      resourceSelections: [{ type: "local_file", path: selectedPath }],
    });
    await lifecycle.setSessionManualName({ sessionId: main.sessionId, name: "Retained Main" });
    const project = main.projectId.slice("sha256:".length);
    const log = join(stateRoot, "projects", project, "sessions", `${main.sessionId}.jsonl`);
    presentation = await createPresentationSession({
      ...options,
      lifecycle,
      sessionId: main.sessionId,
      projectLabel: "Trash fixture",
    });
    const original = await readFile(log);
    expect(
      (
        await presentation.dispatch({
          type: "update_draft_text",
          text: "Retain this next question",
        })
      ).status,
    ).toBe("admitted");
    const ready = Promise.withResolvers<void>();
    const unsubscribe = presentation.subscribe(() => {
      if (presentation?.getState().composer.resources[0]?.state === "ready") ready.resolve();
    });
    try {
      expect(
        (await presentation.dispatch({ type: "stage_input_resource", path: selectedPath })).status,
      ).toBe("admitted");
      if (presentation.getState().composer.resources[0]?.state === "ready") ready.resolve();
      await withManagedFailureGuard(ready.promise, "saved draft resource");
    } finally {
      unsubscribe();
    }
    expect(
      (
        await lifecycle.setSessionVisibility({
          sessionId: main.sessionId,
          visibility: "archived",
          expectedRevision: 0,
        })
      ).status,
    ).toBe("updated");
    const staleDrafts = await createRecoverableTurnDraftRepository({
      stateRoot,
      projectId: main.projectId,
      withMutation: (sessionId, operation) => lifecycle[sessionDraftMutation](sessionId, operation),
    });
    const saved = await staleDrafts.load({ type: "session", sessionId: main.sessionId });
    expect(saved?.schemaVersion).toBe(4);
    const preview = await presentation.dispatch({
      type: "preview_session_trash",
      sessionId: main.sessionId,
    });
    if (preview.status !== "admitted" || preview.trashPreview?.previewId == null)
      throw new Error(JSON.stringify(preview));
    const moved = await presentation.dispatch({
      type: "confirm_session_trash",
      previewId: preview.trashPreview.previewId,
    });
    expect(moved).toMatchObject({ status: "admitted", trashItem: { phase: "trashed" } });
    expect(presentation.getState().authoritative.active).toBeNull();
    await expect(readFile(log)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lifecycle.inspect({ sessionId: main.sessionId })).rejects.toMatchObject({
      code: "session_in_trash",
    });
    if (saved?.schemaVersion !== 4) throw new Error("Missing saved draft");
    await expect(staleDrafts.save(saved)).rejects.toMatchObject({ code: "session_in_trash" });
    await expect(
      readFile(join(stateRoot, "drafts", project, `session-${main.sessionId}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const artifact = join(
      stateRoot,
      "artifacts",
      createHash("sha256").update(resource).digest("hex"),
    );
    await unlink(selectedPath);
    await unlink(artifact);
    const trashed = (await lifecycle.listSessionTrash()).items[0];
    if (trashed === undefined) throw new Error("Missing Trash unit");
    const failed = await lifecycle.restoreSessionTrash({
      transactionId: trashed.transactionId,
      expectedRevision: trashed.revision,
    });
    expect(failed.status).toBe("incomplete");
    expect((await readFile(log)).equals(original)).toBe(true);
    await expect(lifecycle.inspect({ sessionId: main.sessionId })).rejects.toMatchObject({
      code: "session_in_trash",
    });
    const partial = (await lifecycle.listSessionTrash()).items[0];
    expect(partial?.phase).toBe("restoring");
    await presentation.close();
    presentation = undefined;
    await lifecycle.close();
    await writeFile(artifact, resource, { mode: 0o400 });
    lifecycle = createSessionLifecycleForTests(options);
    if (partial === undefined) throw new Error("Missing partial restore");
    expect(
      (
        await lifecycle.continueSessionTrash({
          transactionId: partial.transactionId,
          expectedRevision: partial.revision,
        })
      ).status,
    ).toBe("completed");
    const restored = await lifecycle.inspect({ sessionId: main.sessionId });
    expect(restored).toMatchObject({ schemaVersion: 3, todo: { counts: { pending: 1 } } });
    expect((await readFile(log)).equals(original)).toBe(true);
    expect(
      (await lifecycle.listProjectSessionSummaries({ view: "archived" })).items.map(
        (item) => item.sessionId,
      ),
    ).toEqual([main.sessionId]);
    presentation = await createPresentationSession({
      ...options,
      lifecycle,
      sessionId: main.sessionId,
      projectLabel: "Restored fixture",
    });
    expect(await presentation.dispatch({ type: "read_expanded_draft" })).toMatchObject({
      status: "admitted",
      draftText: expect.stringContaining("Retain this next question"),
    });
    expect(presentation.getState().composer.resources[0]?.state).toBe("ready");
    expect(calls).toBe(2);
  } finally {
    await presentation?.close();
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary derived dependencies block Main Trash while archived and while retained in Trash", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-trash-dependencies-"));
  const workspaceRoot = join(root, "project");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  const lifecycle = createSessionLifecycleForTests({
    workspaceRoot,
    stateRoot,
    modelTargets: modelTargetsWithDriver(new FakeModelDriver([{ type: "finish", reason: "stop" }])),
  });
  try {
    const main = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({ sessionId: main.sessionId, input: { text: "Source" } });
    const source = await lifecycle.inspect({ sessionId: main.sessionId });
    const branch = await lifecycle.branch({
      parentSessionId: main.sessionId,
      atSequence: source.lastSequence,
    });
    expect(
      (
        await lifecycle.setSessionVisibility({
          sessionId: branch.sessionId,
          visibility: "archived",
          expectedRevision: 0,
        })
      ).status,
    ).toBe("updated");
    const blocked = await lifecycle.previewSessionTrash({ sessionId: main.sessionId });
    expect(blocked.previewId).toBeNull();
    expect(blocked.blockers).toContainEqual(
      expect.objectContaining({ kind: "dependency", sessionIds: [branch.sessionId] }),
    );
    const preview = await lifecycle.previewSessionTrash({ sessionId: branch.sessionId });
    if (preview.previewId === null) throw new Error(JSON.stringify(preview));
    expect((await lifecycle.confirmSessionTrash({ previewId: preview.previewId })).status).toBe(
      "completed",
    );
    const stillBlocked = await lifecycle.previewSessionTrash({ sessionId: main.sessionId });
    expect(stillBlocked.blockers).toContainEqual(
      expect.objectContaining({ kind: "dependency", sessionIds: [branch.sessionId] }),
    );
    const transaction = (await lifecycle.listSessionTrash()).items[0];
    if (transaction === undefined) throw new Error("Missing branch transaction");
    expect(
      (
        await lifecycle.restoreSessionTrash({
          transactionId: transaction.transactionId,
          expectedRevision: transaction.revision,
        })
      ).status,
    ).toBe("completed");
    expect((await lifecycle.inspect({ sessionId: branch.sessionId })).schemaVersion).toBe(3);
  } finally {
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("changed previews and unprovable project ownership never move a session", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-trash-preview-"));
  const workspaceRoot = join(root, "project");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  const lifecycle = createSessionLifecycleForTests({
    workspaceRoot,
    stateRoot,
    modelTargets: modelTargetsWithDriver(new FakeModelDriver([{ type: "finish", reason: "stop" }])),
  });
  try {
    const main = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({ sessionId: main.sessionId, input: { text: "Keep this session" } });
    const preview = await lifecycle.previewSessionTrash({ sessionId: main.sessionId });
    if (preview.previewId === null) throw new Error(JSON.stringify(preview));
    await lifecycle.setSessionManualName({
      sessionId: main.sessionId,
      name: "Changed after preview",
    });
    expect(await lifecycle.confirmSessionTrash({ previewId: preview.previewId })).toEqual({
      status: "stale",
    });
    expect(await lifecycle.listSessionTrash()).toEqual({ items: [], diagnostics: [] });
    expect((await lifecycle.inspect({ sessionId: main.sessionId })).status).toBe("settled");
    const other = await lifecycle.create({ targetIdentity });
    const path = join(
      stateRoot,
      "projects",
      main.projectId.slice("sha256:".length),
      "sessions",
      `${other.sessionId}.jsonl`,
    );
    const lines = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    lines[0].record.projectId = `sha256:${"f".repeat(64)}`;
    await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, {
      mode: 0o600,
    });
    const blocked = await lifecycle.previewSessionTrash({ sessionId: main.sessionId });
    expect(blocked.previewId).toBeNull();
    expect(blocked.blockers.length).toBeGreaterThan(0);
    expect(await lifecycle.listSessionTrash()).toEqual({ items: [], diagnostics: [] });
    expect((await lifecycle.inspect({ sessionId: main.sessionId })).status).toBe("settled");
  } finally {
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["history", "draft"] as const)(
  "cold orphan Child %s blocks Trash instead of silently shrinking the unit",
  async (orphan) => {
    const root = await mkdtemp(join(tmpdir(), "adam-trash-orphan-"));
    const workspaceRoot = join(root, "project");
    const stateRoot = join(root, "state");
    await mkdir(workspaceRoot);
    const composition = await createProductionManagedControlComposition({
      workspaceRoot,
      stateRoot,
    });
    const options = {
      workspaceRoot,
      stateRoot,
      managedControl: composition,
      modelTargets: modelTargetsWithDriver(
        new FakeModelDriver([
          { type: "text_delta", text: "Retained ownership evidence" },
          { type: "finish", reason: "stop" },
        ]),
      ),
    };
    let lifecycle = createSessionLifecycleForTests(options);
    try {
      const main = await lifecycle.create({ targetIdentity });
      await lifecycle.continue({ sessionId: main.sessionId, input: { text: "Keep Main" } });
      const project = main.projectId.slice("sha256:".length);
      let retainedPath: string;
      if (orphan === "history") {
        const control = await lifecycle[sessionManagedControl](main.sessionId);
        if (control === undefined) throw new Error("Missing real Control");
        const admission = await control.dispatch({
          type: "spawn_agents",
          parentSessionId: main.sessionId,
          entries: [
            { role: "builtin:explore", task: "Retained Child", description: "Ownership test" },
          ],
        });
        if (admission.status !== "admitted" || admission.turns[0] === undefined)
          throw new Error(JSON.stringify(admission));
        const turn = admission.turns[0];
        expect(
          (
            await withManagedFailureGuard(
              control.dispatch({
                type: "wait_agents",
                parentSessionId: main.sessionId,
                targets: [{ threadId: turn.threadId, expectedTurnId: turn.turnId }],
                mode: "all",
              }),
              "settled orphan fixture",
            )
          ).status,
        ).toBe("completed");
        retainedPath = join(
          stateRoot,
          "managed-agent-sessions",
          "projects",
          project,
          "sessions",
          `${turn.childSessionId}.jsonl`,
        );
        await lifecycle.close();
        await unlink(
          join(
            stateRoot,
            "projects",
            project,
            "managed-agents",
            `events-v3-${main.sessionId}.jsonl`,
          ),
        );
      } else {
        const threadId = randomUUID();
        const drafts = await createRecoverableTurnDraftRepository({
          stateRoot,
          projectId: main.projectId,
        });
        await drafts.saveManaged({
          parentSessionId: main.sessionId,
          threadId,
          expectedTurnId: randomUUID(),
          mode: "new_turn",
          text: "Unattributed but retained draft",
        });
        retainedPath = join(
          stateRoot,
          "drafts",
          project,
          `managed-${main.sessionId}-${threadId}.json`,
        );
        await lifecycle.close();
      }
      const original = await readFile(retainedPath);
      lifecycle = createSessionLifecycleForTests(options);
      const preview = await lifecycle.previewSessionTrash({ sessionId: main.sessionId });
      expect(preview.previewId).toBeNull();
      expect(preview.blockers).toHaveLength(1);
      expect(preview.blockers[0]?.message).toMatch(/ownership|admission/u);
      expect(await lifecycle.listSessionTrash()).toEqual({ items: [], diagnostics: [] });
      expect((await readFile(retainedPath)).equals(original)).toBe(true);
      expect((await lifecycle.inspect({ sessionId: main.sessionId })).status).toBe("settled");
    } finally {
      await lifecycle.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(["prepare", "trash", "restore"] as const)(
  "process death at the real %s boundary preserves explicit cold recovery",
  async (action) => {
    const root = await mkdtemp(join(tmpdir(), "adam-trash-process-"));
    const workspaceRoot = join(root, "project");
    const stateRoot = join(root, "state");
    await mkdir(workspaceRoot);
    let calls = 0;
    const options = {
      workspaceRoot,
      stateRoot,
      modelTargets: modelTargetsWithDriver(
        new FakeModelDriver(() => {
          calls += 1;
          return [
            { type: "text_delta", text: "Crash-safe transcript" },
            { type: "finish", reason: "stop" },
          ];
        }),
      ),
    };
    let lifecycle = createSessionLifecycleForTests(options);
    let child: ReturnType<typeof fork> | undefined;
    let closed: Promise<void> | undefined;
    try {
      const main = await lifecycle.create({ targetIdentity });
      await lifecycle.continue({
        sessionId: main.sessionId,
        input: { text: "Prepare retained history" },
      });
      const log = join(
        stateRoot,
        "projects",
        main.projectId.slice("sha256:".length),
        "sessions",
        `${main.sessionId}.jsonl`,
      );
      const original = await readFile(log);
      const drafts = await createRecoverableTurnDraftRepository({
        stateRoot,
        projectId: main.projectId,
      });
      await drafts.save({
        schemaVersion: 4,
        scope: { type: "session", sessionId: main.sessionId },
        nextOrdinal: 1,
        resources: [],
        pastedTexts: [],
        elements: [{ type: "text", elementId: "retained", text: "Process-safe draft" }],
      });
      let identity = main.sessionId;
      if (action === "restore") {
        const preview = await lifecycle.previewSessionTrash({ sessionId: main.sessionId });
        if (preview.previewId === null) throw new Error(JSON.stringify(preview));
        expect((await lifecycle.confirmSessionTrash({ previewId: preview.previewId })).status).toBe(
          "completed",
        );
        identity = (await lifecycle.listSessionTrash()).items[0]?.transactionId ?? "";
      }
      await lifecycle.close();
      const linked = Promise.withResolvers<void>();
      child = fork(
        fileURLToPath(new URL("../dist/session-trash-crash.fixture.js", import.meta.url)),
        [workspaceRoot, stateRoot, action, identity],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      closed = new Promise<void>((resolve) => {
        child?.once("close", () => resolve());
      });
      child.once("error", (error) => linked.reject(error));
      child.on("message", (message: unknown) => {
        if (
          message !== null &&
          typeof message === "object" &&
          "type" in message &&
          message.type === (action === "prepare" ? "prepared" : "linked")
        )
          linked.resolve();
        else linked.reject(new Error(`Crash boundary not reached: ${JSON.stringify(message)}`));
      });
      child.once("close", () =>
        linked.reject(new Error(`Process closed before the link boundary: ${stderr}`)),
      );
      await withManagedFailureGuard(linked.promise, "actual link effect before process death");
      child.kill("SIGKILL");
      await withManagedFailureGuard(closed, "killed transaction process closure");
      expect(stderr).toBe("");
      const presentBeforeReopen = await readFile(log).then(
        () => true,
        () => false,
      );
      lifecycle = createSessionLifecycleForTests(options);
      if (action === "prepare") {
        expect(await lifecycle.listSessionTrash()).toEqual({ items: [], diagnostics: [] });
        expect((await readFile(log)).equals(original)).toBe(true);
        expect((await lifecycle.inspect({ sessionId: main.sessionId })).status).toBe("settled");
        const preview = await lifecycle.previewSessionTrash({ sessionId: main.sessionId });
        if (preview.previewId === null) throw new Error(JSON.stringify(preview));
        expect((await lifecycle.confirmSessionTrash({ previewId: preview.previewId })).status).toBe(
          "completed",
        );
        const fresh = (await lifecycle.listSessionTrash()).items[0];
        if (fresh === undefined) throw new Error("Fresh preparation did not publish");
        expect(
          (
            await lifecycle.restoreSessionTrash({
              transactionId: fresh.transactionId,
              expectedRevision: fresh.revision,
            })
          ).status,
        ).toBe("completed");
        expect((await readFile(log)).equals(original)).toBe(true);
        return;
      }
      const item = (await lifecycle.listSessionTrash()).items[0];
      expect(item?.phase).toBe(action === "trash" ? "trashing" : "restoring");
      expect(
        await readFile(log).then(
          () => true,
          () => false,
        ),
      ).toBe(presentBeforeReopen);
      expect((await lifecycle.listProjectSessionSummaries()).items).toEqual([]);
      await expect(lifecycle.inspect({ sessionId: main.sessionId })).rejects.toMatchObject({
        code: "session_in_trash",
      });
      if (item === undefined) throw new Error("Missing interrupted transaction");
      const continued = await lifecycle.continueSessionTrash({
        transactionId: item.transactionId,
        expectedRevision: item.revision,
      });
      expect(continued.status).toBe("completed");
      if (action === "trash") {
        const trashed = (await lifecycle.listSessionTrash()).items[0];
        if (trashed === undefined) throw new Error("Missing continued Trash entry");
        expect(
          (
            await lifecycle.restoreSessionTrash({
              transactionId: trashed.transactionId,
              expectedRevision: trashed.revision,
            })
          ).status,
        ).toBe("completed");
      }
      expect((await readFile(log)).equals(original)).toBe(true);
      expect((await lifecycle.inspect({ sessionId: main.sessionId })).status).toBe("settled");
      expect((await drafts.load({ type: "session", sessionId: main.sessionId }))?.elements).toEqual(
        [{ type: "text", elementId: "retained", text: "Process-safe draft" }],
      );
      expect(calls).toBe(1);
    } finally {
      if (child !== undefined && child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      if (closed !== undefined) await withManagedFailureGuard(closed, "crash fixture cleanup");
      await lifecycle.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
