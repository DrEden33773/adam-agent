import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createRecoverableTurnDraftRepository } from "./recoverable-turn-draft.js";

const projectId = `sha256:${"b".repeat(64)}` as const;

test("recoverable turn draft atomically replaces one owner-private project manifest", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-recoverable-turn-draft-"));
  const repository = await createRecoverableTurnDraftRepository({
    projectId,
    stateRoot: testRoot,
  });
  const first = {
    schemaVersion: 2 as const,
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
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});
