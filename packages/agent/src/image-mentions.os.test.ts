import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { createFileTurnComposerResourceStager } from "./input-resource-staging.js";
import { createTurnComposer } from "./turn-composer.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test.each(["completion", "path mention", "typed", "quoted", "home"])(
  "%s image mention becomes an immutable image in its original position",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "adam-image-mention-"));
    const workspaceRoot = join(root, "project");
    await mkdir(workspaceRoot);
    const path = join(workspaceRoot, "截图 image.PNG");
    await writeFile(path, png);
    const stager = await createFileTurnComposerResourceStager({
      artifactRoot: join(root, "artifacts"),
      workspaceRoot,
    });
    const composer = await createTurnComposer({ onChange() {}, stager });
    try {
      if (mode === "path mention") {
        await composer.replaceText({
          baseRevision: 0,
          document: [
            { type: "text", text: "before " },
            {
              type: "mention",
              kind: "path",
              elementId: "selected-image",
              literal: "@截图%20image.PNG",
              path: "截图 image.PNG",
            },
            { type: "text", text: " after" },
          ],
        });
      } else if (mode === "completion") {
        await composer.replaceText({
          baseRevision: 0,
          document: [
            { type: "text", text: "before " },
            { type: "path", elementId: "selected-image", path: "截图 image.PNG" },
            { type: "text", text: " after" },
          ],
        });
      } else {
        const simple = join(workspaceRoot, "image.png");
        await writeFile(simple, png);
        composer.setText(
          mode === "quoted"
            ? 'before @"截图 image.PNG" after'
            : mode === "home"
              ? `before @~/${relative(homedir(), simple)} after`
              : `before @${simple} after`,
        );
      }
      await composer.prepareImageReferences({
        includeText: true,
        signal: new AbortController().signal,
      });
      expect(composer.snapshot().renderedText).toBe("before [Image #1] after");
      expect(composer.snapshot().resources).toMatchObject([
        {
          sourcePath:
            mode === "home"
              ? `~/${relative(homedir(), join(workspaceRoot, "image.png"))}`
              : mode === "typed"
                ? join(workspaceRoot, "image.png")
                : "截图 image.PNG",
          token: "[Image #1]",
        },
      ]);
      const sealed = await composer.seal(new AbortController().signal);
      expect(sealed.structuredContent).toEqual([
        { type: "text", text: "before " },
        { type: "input_resource", selectionIndex: 0, draftOrdinal: 1 },
        { type: "text", text: " after" },
      ]);
      expect(sealed.selections).toHaveLength(1);
      expect(sealed.selections[0]?.support).toBe("image");
      expect(sealed.selections[0]).not.toHaveProperty("sourcePath");
      await rm(path);
      expect(
        await readFile(
          join(
            root,
            "artifacts",
            ".input-resource-staging",
            sealed.selections[0]?.staged.stagingId ?? "missing-stage",
          ),
        ),
      ).toEqual(png);
    } finally {
      await composer.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("failed or cancelled staging preserves the exact reference and retry creates one resource", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-image-retry-"));
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let hold = false;
  const stager = await createFileTurnComposerResourceStager({
    artifactRoot: join(root, "artifacts"),
    workspaceRoot: root,
    stageBarrier: {
      async afterOpen() {
        if (hold) {
          started.resolve();
          await release.promise;
        }
      },
    },
  });
  const composer = await createTurnComposer({ onChange() {}, stager });
  const prepare = (signal = new AbortController().signal) =>
    composer.prepareImageReferences({ includeText: true, signal });
  try {
    composer.setText("Inspect @image.png please.");
    await expect(prepare()).rejects.toThrow("image.png");
    await writeFile(join(root, "image.png"), "not an image");
    await expect(prepare()).rejects.toThrow("PNG or JPEG");
    expect(composer.snapshot().renderedText).toBe("Inspect @image.png please.");
    expect(composer.snapshot().resources).toEqual([]);
    await writeFile(join(root, "image.png"), png);
    hold = true;
    const controller = new AbortController();
    const pending = expect(prepare(controller.signal)).rejects.toThrow();
    await started.promise;
    expect(composer.snapshot().sealed).toBe(true);
    controller.abort();
    release.resolve();
    await pending;
    expect(composer.snapshot().renderedText).toBe("Inspect @image.png please.");
    expect(composer.snapshot().sealed).toBe(false);
    hold = false;
    await prepare();
    await prepare();
    expect(composer.snapshot().resources).toHaveLength(1);
    expect(composer.snapshot().renderedText).toBe("Inspect [Image #1] please.");
  } finally {
    release.resolve();
    await composer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("converted images retain remove/undo and cold draft recovery without the source file", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-image-recover-"));
  const stager = await createFileTurnComposerResourceStager({
    artifactRoot: join(root, "artifacts"),
    workspaceRoot: root,
  });
  const composer = await createTurnComposer({ onChange() {}, stager });
  let cold: Awaited<ReturnType<typeof createTurnComposer>> | undefined;
  try {
    await writeFile(join(root, "image.png"), png);
    composer.setText("Inspect @image.png.");
    await composer.prepareImageReferences({
      includeText: true,
      signal: new AbortController().signal,
    });
    const resource = composer.snapshot().resources[0];
    if (resource === undefined) throw new Error("Expected an image resource.");
    expect(await composer.remove(resource.id)).toBe(true);
    expect(composer.snapshot().renderedText).toBe("Inspect .");
    expect(await composer.undo(composer.snapshot().revision)).toBe(true);
    const draft = await composer.captureDraft({
      type: "new_session",
      targetId: "deepseek-flash.direct",
    });
    expect(draft.resources[0]?.sourcePath).toBe("image.png");
    await composer.close();
    await rm(join(root, "image.png"));
    cold = await createTurnComposer({
      onChange() {},
      stager: await createFileTurnComposerResourceStager({
        artifactRoot: join(root, "artifacts"),
        workspaceRoot: root,
      }),
    });
    await cold.restoreDraft(draft);
    expect(cold.snapshot().resources[0]?.sourcePath).toBe("image.png");
    await cold.prepareImageReferences({ includeText: true, signal: new AbortController().signal });
    const sealed = await cold.seal(new AbortController().signal);
    expect(sealed.selections).toHaveLength(1);

    expect(
      await readFile(
        join(
          root,
          "artifacts",
          ".input-resource-staging",
          sealed.selections[0]?.staged.stagingId ?? "missing-stage",
        ),
      ),
    ).toEqual(png);
  } finally {
    await (cold ?? composer).close();
    await rm(root, { recursive: true, force: true });
  }
});

test("folded pasted prose attaches its image while preserving surrounding text and fenced code", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-pasted-image-"));
  const composer = await createTurnComposer({
    onChange() {},
    stager: await createFileTurnComposerResourceStager({
      artifactRoot: join(root, "artifacts"),
      workspaceRoot: root,
    }),
  });
  try {
    await writeFile(join(root, "image.png"), png);
    const before = "before\n".repeat(12);
    const after = ["\n```\n@code.png\n```\n", "after\n".repeat(12)].join("");
    await composer.stagePastedText(`${before}@image.png${after}`);
    await composer.prepareImageReferences({
      includeText: true,
      signal: new AbortController().signal,
    });
    expect(composer.readExpandedText()).toBe(`${before}[Image #3]${after}`);
    const sealed = await composer.seal(new AbortController().signal);
    expect(sealed.selections).toHaveLength(1);
    expect(sealed.pastedTextSelections).toHaveLength(2);
  } finally {
    await composer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("multiple image references and an unavailable attachment profile preserve the draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-image-limits-"));
  const composer = await createTurnComposer({
    onChange() {},
    stager: await createFileTurnComposerResourceStager({
      artifactRoot: join(root, "artifacts"),
      workspaceRoot: root,
    }),
  });
  try {
    composer.setText("@one.png @two.jpg");
    await expect(
      composer.prepareImageReferences({ includeText: true, signal: new AbortController().signal }),
    ).rejects.toThrow("Only one image");
    expect(composer.snapshot().renderedText).toBe("@one.png @two.jpg");
    composer.setText("@one.png");
    await expect(
      composer.prepareImageReferences({
        includeText: true,
        available: false,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("New session required");
    expect(composer.snapshot().resources).toEqual([]);
  } finally {
    await composer.close();
    await rm(root, { recursive: true, force: true });
  }
});
