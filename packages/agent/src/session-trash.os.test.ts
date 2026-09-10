import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import {
  createSessionTrashRepository,
  type SessionTrashFileSystem,
  type SessionTrashUnit,
} from "./session-trash.js";

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "adam-trash-files-"));
  const workspaceRoot = join(root, "project");
  const stateRoot = join(root, "state");
  await fs.mkdir(workspaceRoot, { mode: 0o700 });
  const project = createHash("sha256")
    .update(await fs.realpath(workspaceRoot))
    .digest("hex");
  const mainSessionId = randomUUID();
  const main = join(stateRoot, "projects", project, "sessions", `${mainSessionId}.jsonl`);
  const draft = join(stateRoot, "drafts", project, `session-${mainSessionId}.json`);
  const artifact = join(stateRoot, "artifacts", "retained.txt");
  for (const path of [main, draft, artifact]) {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path,
      path === main
        ? "Main transcript\n"
        : path === draft
          ? "Retained draft\n"
          : "Referenced artifact\n",
      { mode: 0o600 },
    );
  }
  const unit: SessionTrashUnit = {
    mainSessionId,
    label: "Restorable session",
    children: [],
    threadIds: [],
    sourceSessionIds: [],
    archived: true,
  };
  const options = { workspaceRoot, stateRoot };
  const repository = createSessionTrashRepository(options);
  const files = await repository.inspectFiles(unit, [{ kind: "main" }, { kind: "main_draft" }]);
  return { root, options, repository, unit, files, main, draft, artifact };
}

test("Trash retains the whole file unit, refuses an occupied Restore target, and validates actual retained reads", async () => {
  const h = await fixture();
  try {
    const prepared = await h.repository.prepare(h.unit, h.files);
    await expect(h.repository.assertAccessible(h.unit.mainSessionId)).rejects.toThrow(
      "unfinished transaction",
    );
    expect(await fs.readFile(h.main, "utf8")).toBe("Main transcript\n");
    expect(
      await h.repository.execute(prepared.transactionId, prepared.revision, false),
    ).toMatchObject({ status: "completed", manifest: { phase: "trashed" } });
    await expect(fs.readFile(h.main)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(h.draft)).rejects.toMatchObject({ code: "ENOENT" });
    const cold = createSessionTrashRepository(h.options);
    const trashed = await cold.readManifest(prepared.transactionId);
    await fs.writeFile(h.main, "Do not overwrite\n", { mode: 0o600 });
    expect(
      await cold.execute(trashed.transactionId, trashed.revision, true, async () => {}),
    ).toMatchObject({ status: "conflict" });
    expect(await fs.readFile(h.main, "utf8")).toBe("Do not overwrite\n");
    await expect(fs.readFile(h.draft)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.unlink(h.main);
    let validated = false;
    expect(
      await cold.execute(trashed.transactionId, trashed.revision, true, async () => {
        expect(await fs.readFile(h.main, "utf8")).toBe("Main transcript\n");
        expect(await fs.readFile(h.draft, "utf8")).toBe("Retained draft\n");
        expect(await fs.readFile(h.artifact, "utf8")).toBe("Referenced artifact\n");
        await expect(cold.assertAccessible(h.unit.mainSessionId)).rejects.toThrow(
          "unfinished transaction",
        );
        validated = true;
      }),
    ).toMatchObject({
      status: "completed",
      manifest: { phase: "restored", unit: { archived: true } },
    });
    expect(validated).toBe(true);
    await expect(cold.assertAccessible(h.unit.mainSessionId)).resolves.toBeUndefined();
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test.each(["link", "unlink", "sync"] as const)(
  "an actual %s boundary failure remains recoverable without moving data on reopen",
  async (phase) => {
    const h = await fixture();
    let linked = false;
    let failed = false;
    const fileSystem: SessionTrashFileSystem = {
      ...fs,
      async link(source, destination) {
        await fs.link(source, destination);
        linked = true;
        if (phase === "link" && !failed) {
          failed = true;
          throw new Error("Injected failure after link effect");
        }
      },
      async unlink(path) {
        await fs.unlink(path);
        if (phase === "unlink" && !failed) {
          failed = true;
          throw new Error("Injected failure after unlink effect");
        }
      },
      async open(...args) {
        const file = await fs.open(...args);
        const sync = file.sync.bind(file);
        file.sync = async () => {
          if (phase === "sync" && linked && !failed) {
            failed = true;
            throw new Error("Injected directory sync failure");
          }
          return sync();
        };
        return file;
      },
    };
    try {
      const interrupted = createSessionTrashRepository({ ...h.options, fileSystem });
      const prepared = await interrupted.prepare(h.unit, h.files);
      expect(
        await interrupted.execute(prepared.transactionId, prepared.revision, false),
      ).toMatchObject({ status: "incomplete" });
      expect(failed).toBe(true);
      const mainPresent = await fs.readFile(h.main, "utf8").catch(() => null);
      const cold = createSessionTrashRepository(h.options);
      const reopened = await cold.list();
      expect(reopened.transactions[0]?.phase).toBe("trashing");
      expect(await fs.readFile(h.main, "utf8").catch(() => null)).toBe(mainPresent);
      const partial = reopened.transactions[0];
      if (partial === undefined) throw new Error("Missing recoverable manifest");
      expect(
        await cold.execute(partial.transactionId, partial.revision, true, async () => {
          expect(await fs.readFile(h.main, "utf8")).toBe("Main transcript\n");
          expect(await fs.readFile(h.draft, "utf8")).toBe("Retained draft\n");
        }),
      ).toMatchObject({ status: "completed", manifest: { phase: "restored" } });
    } finally {
      await fs.rm(h.root, { recursive: true, force: true });
    }
  },
);

test("a Restore target created after preflight is never overwritten", async () => {
  const h = await fixture();
  try {
    const prepared = await h.repository.prepare(h.unit, h.files);
    expect((await h.repository.execute(prepared.transactionId, 0, false)).status).toBe("completed");
    const manifest = await h.repository.readManifest(prepared.transactionId);
    let competed = false;
    const competing = createSessionTrashRepository({
      ...h.options,
      fileSystem: {
        ...fs,
        async link(source, destination) {
          if (!competed) {
            competed = true;
            await fs.writeFile(destination, "Competing target\n", { flag: "wx", mode: 0o600 });
          }
          await fs.link(source, destination);
        },
      },
    });
    expect(
      (await competing.execute(manifest.transactionId, manifest.revision, true, async () => {}))
        .status,
    ).toBe("incomplete");
    expect(await fs.readFile(h.main, "utf8")).toBe("Competing target\n");
    await expect(fs.readFile(h.draft)).rejects.toMatchObject({ code: "ENOENT" });
    const partial = await h.repository.readManifest(manifest.transactionId);
    expect(
      (await h.repository.execute(partial.transactionId, partial.revision, true, async () => {}))
        .status,
    ).toBe("conflict");
    expect(await fs.readFile(h.main, "utf8")).toBe("Competing target\n");
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});
