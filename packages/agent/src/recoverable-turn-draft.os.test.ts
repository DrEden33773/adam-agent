import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createRecoverableTurnDraftRepository } from "./recoverable-turn-draft.js";

const projectId = `sha256:${"b".repeat(64)}` as const;

test("late input acceptance clears only its exact owner-private child draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-child-draft-clear-"));
  const repository = await createRecoverableTurnDraftRepository({ projectId, stateRoot: root });
  const first = {
    parentSessionId: "00000000-0000-4000-8000-000000000001",
    threadId: "00000000-0000-4000-8000-000000000002",
    expectedTurnId: "00000000-0000-4000-8000-000000000003",
    inputId: "00000000-0000-4000-8000-000000000004",
    mode: "cooperative" as const,
    text: "The submitted input.",
  };
  const later = {
    ...first,
    inputId: "00000000-0000-4000-8000-000000000005",
    text: "A newer unsent draft.",
  };
  try {
    await repository.saveManaged(first);
    await repository.saveManaged(later);
    await expect(repository.clearManaged(first)).resolves.toBe(false);
    const reopened = await createRecoverableTurnDraftRepository({ projectId, stateRoot: root });
    await expect(reopened.loadManaged(first)).resolves.toEqual(later);
    const path = join(
      root,
      "drafts",
      "b".repeat(64),
      `managed-${first.parentSessionId}-${first.threadId}.json`,
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(repository.clearManaged(later)).resolves.toBe(true);
    await expect(reopened.loadManaged(first)).resolves.toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recoverable turn draft atomically replaces one owner-private project manifest", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-recoverable-turn-draft-"));
  const repository = await createRecoverableTurnDraftRepository({
    projectId,
    stateRoot: testRoot,
  });
  const first = {
    schemaVersion: 3 as const,
    scope: { type: "new_session" as const, targetId: "deepseek-v4-flash.direct" },
    nextOrdinal: 1,
    elements: [{ elementId: "text-1", type: "text" as const, text: "first" }],
    resources: [],
  };
  const second = {
    ...first,
    elements: [{ elementId: "text-1", type: "text" as const, text: "second" }],
  };

  try {
    await repository.save(first);
    await repository.save(second);
    await expect(repository.load({ type: "new_session" })).resolves.toEqual(second);

    const draftsRoot = join(testRoot, "drafts", "b".repeat(64));
    const entries = await readdir(draftsRoot);
    expect(entries).toEqual(["new-session.json"]);
    expect((await stat(draftsRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(join(draftsRoot, "new-session.json"))).mode & 0o777).toBe(0o600);

    await repository.delete({ type: "new_session" });
    await expect(repository.load({ type: "new_session" })).resolves.toBeNull();
    await expect(readdir(draftsRoot)).resolves.toEqual([]);

    const legacy = { ...first, schemaVersion: 1 as const };
    await writeFile(join(draftsRoot, "new-session.json"), `${JSON.stringify(legacy)}\n`, {
      mode: 0o600,
    });
    await expect(repository.load({ type: "new_session" })).resolves.toEqual(legacy);
    await repository.delete({ type: "new_session" });

    const previous = { ...first, schemaVersion: 2 as const };
    await writeFile(join(draftsRoot, "new-session.json"), `${JSON.stringify(previous)}\n`, {
      mode: 0o600,
    });
    await expect(repository.load({ type: "new_session" })).resolves.toEqual(previous);
    await repository.delete({ type: "new_session" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("recoverable turn draft rejects a V2 graph whose Skill text exceeds the payload limit", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-recoverable-turn-draft-limit-"));
  const repository = await createRecoverableTurnDraftRepository({ projectId, stateRoot: testRoot });
  const manifestPath = join(testRoot, "drafts", "b".repeat(64), "new-session.json");
  const pastedTextId = "pasted-text-1";
  const pastedTextElementId = "pasted-text-element-1";
  const draft = {
    schemaVersion: 2,
    scope: { type: "new_session", targetId: "deepseek-v4-flash.direct" },
    nextOrdinal: 2,
    elements: [
      {
        elementId: pastedTextElementId,
        type: "pasted_text",
        ordinal: 1,
        pastedTextId,
      },
      {
        elementId: "skill-1",
        type: "skill",
        name: "a".repeat(64),
        qualifiedId: "skill:v1:project:.:maximum-name-skill",
      },
    ],
    resources: [],
    pastedTexts: [
      {
        id: pastedTextId,
        elementId: pastedTextElementId,
        ordinal: 1,
        state: "failed",
        byteCount: 1024 * 1024 - 64,
        lineCount: 1,
        scalarCount: 1024 * 1024 - 64,
        diagnostic: "Unavailable test payload.",
      },
    ],
  };

  try {
    await repository.save({
      schemaVersion: 3,
      scope: { type: "new_session", targetId: "deepseek-v4-flash.direct" },
      nextOrdinal: 1,
      elements: [],
      resources: [],
    });
    await writeFile(manifestPath, `${JSON.stringify(draft)}\n`, "utf8");
    await expect(repository.load({ type: "new_session" })).rejects.toThrow(
      "The recoverable draft manifest is invalid.",
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});
