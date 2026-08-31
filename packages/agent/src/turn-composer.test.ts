import { expect, test } from "vitest";

import type { TurnComposerResourceStager } from "./input-resource-staging.js";
import { pastedTextLimitsV1 } from "./pasted-text.js";
import type { RecoverableTurnDraftV1 } from "./recoverable-turn-draft.js";
import { createTurnComposer } from "./turn-composer.js";

const digest = `sha256:${"a".repeat(64)}` as const;

function createPastedTextStager(): TurnComposerResourceStager {
  const texts = new Map<string, string>();
  return {
    async stage() {
      throw new Error("No file should be staged in this test.");
    },
    async stageText(input) {
      texts.set(input.id, input.text);
      return {
        type: "staged_pasted_text",
        staged: {
          stagingId: input.id,
          id: digest,
          mediaType: "text/plain; charset=utf-8",
          byteCount: Buffer.byteLength(input.text, "utf8"),
        },
        digest,
        byteCount: Buffer.byteLength(input.text, "utf8"),
        lineCount: input.text.split("\n").length,
        scalarCount: Array.from(input.text).length,
      };
    },
    async readText(selection) {
      const text = texts.get(selection.staged.stagingId);
      if (text === undefined) {
        throw new Error("The staged pasted text is unavailable.");
      }
      return text;
    },
    async retain() {},
    async discard() {},
    async close() {},
  };
}

test("TurnComposer derives one safe bounded preview from pasted text", async () => {
  const composer = await createTurnComposer({ onChange() {}, stager: createPastedTextStager() });
  try {
    await composer.stagePastedText("\u001b[31m\t《红楼梦》\u3000第五回\u001b[0m\u202e\n后文");
    expect(composer.snapshot().pastedTexts).toMatchObject([
      { preview: "《红楼梦》 第五回...", state: "ready" },
    ]);
  } finally {
    await composer.close();
  }
});

test("TurnComposer uses the exact empty fallback after terminal-string sanitization", async () => {
  const composer = await createTurnComposer({ onChange() {}, stager: createPastedTextStager() });
  try {
    await composer.stagePastedText("\u001b_PRIVATE\u001b\\");
    expect(composer.snapshot().pastedTexts).toMatchObject([
      { preview: "(empty after sanitization)", state: "ready" },
    ]);
  } finally {
    await composer.close();
  }
});

test("TurnComposer removes malformed ESC controls without deleting following visible text", async () => {
  const composer = await createTurnComposer({ onChange() {}, stager: createPastedTextStager() });
  try {
    await composer.stagePastedText("A\u001bXB");
    expect(composer.snapshot().pastedTexts).toMatchObject([{ preview: "AXB", state: "ready" }]);
  } finally {
    await composer.close();
  }
});

test("TurnComposer restores a derived preview without persisting a second copy", async () => {
  const stager = createPastedTextStager();
  const composer = await createTurnComposer({ onChange() {}, stager });
  const recovered = await createTurnComposer({ onChange() {}, stager });
  try {
    const pasted = Array.from({ length: 11 }, (_, index) => `recovered paste ${index + 1}`).join(
      "\n",
    );
    await composer.stagePastedText(pasted);
    const draft = await composer.captureDraft({ type: "new_session", targetId: "fake.local" });
    expect(draft).not.toHaveProperty("preview");
    expect(JSON.stringify(draft)).not.toContain("recovered...");
    await recovered.restoreDraft(draft);
    expect(recovered.snapshot().pastedTexts).toMatchObject([
      { preview: "recovered...", state: "ready" },
    ]);
  } finally {
    await recovered.close();
    await composer.close();
  }
});

test("TurnComposer expands a Skill atom to visible text without copying identity metadata", async () => {
  const composer = await createTurnComposer({ onChange() {}, stager: createPastedTextStager() });
  try {
    composer.setText("$fir");
    await expect(
      composer.replaceText({
        baseRevision: composer.snapshot().revision,
        document: [
          {
            type: "skill",
            elementId: "skill-occurrence",
            name: "first",
            qualifiedId: "skill:v1:project:.:first",
          },
        ],
      }),
    ).resolves.toBe(true);
    expect(composer.readExpandedText()).toBe("$first");
    expect(composer.readExpandedText()).not.toContain("skill:v1:");
    await expect(composer.seal(new AbortController().signal)).resolves.toMatchObject({
      text: "$first",
      skillOccurrences: [
        {
          elementId: "skill-occurrence",
          qualifiedId: "skill:v1:project:.:first",
        },
      ],
    });
  } finally {
    await composer.close();
  }
});

test("TurnComposer counts a candidate Skill atom against the structured text byte limit", async () => {
  const composer = await createTurnComposer({ onChange() {}, stager: createPastedTextStager() });
  try {
    await composer.stagePastedText("x".repeat(pastedTextLimitsV1.maximumTextBytesPerTurn - 64));
    const pastedText = composer
      .snapshot()
      .elements.find((element) => element.type === "pasted_text");
    if (pastedText?.type !== "pasted_text") {
      throw new Error("Expected one staged Text atom.");
    }

    await expect(
      composer.replaceText({
        baseRevision: composer.snapshot().revision,
        document: [
          { type: "pasted_text", elementId: pastedText.elementId },
          {
            type: "skill",
            elementId: "maximum-name-skill",
            name: "a".repeat(64),
            qualifiedId: "skill:v1:project:.:maximum-name-skill",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  } finally {
    await composer.close();
  }
});

test("TurnComposer rejects a malformed pasted image before publishing a draft mutation", async () => {
  let publications = 0;
  let stagingInvoked = false;
  const stager: TurnComposerResourceStager = {
    async stage() {
      throw new Error("No file should be staged in this test.");
    },
    async stageImage() {
      stagingInvoked = true;
      throw new Error("Malformed bytes must not reach artifact staging.");
    },
    async retain() {},
    async discard() {},
    async close() {},
  };
  const composer = await createTurnComposer({
    onChange() {
      publications += 1;
    },
    stager,
  });

  try {
    await expect(composer.stagePastedImage(Buffer.from("not an image"))).rejects.toThrow(
      "not a complete valid PNG or JPEG",
    );
    expect(stagingInvoked).toBe(false);
    expect(publications).toBe(0);
    expect(composer.snapshot()).toMatchObject({
      elements: [],
      renderedText: "",
      resources: [],
      revision: 0,
    });
  } finally {
    await composer.close();
  }
});

test("TurnComposer does not publish or retain text when its recoverable commit fails", async () => {
  let publications = 0;
  const stager: TurnComposerResourceStager = {
    async stage() {
      throw new Error("No resource should be staged in this test.");
    },
    async retain() {},
    async discard() {},
    async close() {},
  };
  const composer = await createTurnComposer({
    onChange() {
      publications += 1;
    },
    stager,
  });

  try {
    await expect(
      composer.commitText("must stay hidden", async () => {
        throw new Error("simulated manifest failure");
      }),
    ).rejects.toThrow("simulated manifest failure");
    expect(composer.snapshot()).toMatchObject({
      elements: [],
      renderedText: "",
      revision: 0,
    });
    expect(publications).toBe(0);
  } finally {
    await composer.close();
  }
});

test("TurnComposer withdraws a newly staged resource when its recoverable commit fails", async () => {
  const publications: string[] = [];
  const stager: TurnComposerResourceStager = {
    async stage(input) {
      return {
        type: "staged_artifact",
        staged: {
          stagingId: input.id,
          id: digest,
          mediaType: "text/plain; charset=utf-8",
          byteCount: 5,
        },
        displayName: "notes.txt",
        digest,
        mediaHint: "text",
        support: "utf8_text",
      };
    },
    async retain() {},
    async discard() {},
    async close() {},
  };
  let composer: Awaited<ReturnType<typeof createTurnComposer>>;
  composer = await createTurnComposer({
    onChange() {
      publications.push(composer.snapshot().renderedText);
    },
    stager,
  });

  try {
    await expect(
      composer.stage("/selected/notes.txt", undefined, async () => {
        throw new Error("simulated manifest failure");
      }),
    ).rejects.toThrow("simulated manifest failure");
    expect(composer.snapshot()).toMatchObject({
      elements: [],
      renderedText: "",
      resources: [],
      revision: 0,
    });
    expect(publications.at(-1)).toBe("");
  } finally {
    await composer.close();
  }
});

test("TurnComposer restores a ready resource when its removal commit fails", async () => {
  let publications = 0;
  const stager: TurnComposerResourceStager = {
    async stage(input) {
      return {
        type: "staged_artifact",
        staged: {
          stagingId: input.id,
          id: digest,
          mediaType: "text/plain; charset=utf-8",
          byteCount: 5,
        },
        displayName: "notes.txt",
        digest,
        mediaHint: "text",
        support: "utf8_text",
      };
    },
    async retain() {},
    async discard() {},
    async close() {},
  };
  const composer = await createTurnComposer({
    onChange() {
      publications += 1;
    },
    stager,
  });

  try {
    const resourceId = await composer.stage("/selected/notes.txt");
    const before = composer.snapshot();
    const publicationsBeforeRemoval = publications;
    await expect(
      composer.remove(resourceId, async () => {
        throw new Error("simulated manifest failure");
      }),
    ).rejects.toThrow("simulated manifest failure");
    expect(composer.snapshot()).toEqual(before);
    expect(publications).toBe(publicationsBeforeRemoval);
  } finally {
    await composer.close();
  }
});

test("TurnComposer inserts one staged file at an exact text point without flattening the draft", async () => {
  const stager: TurnComposerResourceStager = {
    async stage(input) {
      return {
        type: "staged_artifact",
        staged: {
          stagingId: input.id,
          id: digest,
          mediaType: "text/plain; charset=utf-8",
          byteCount: 5,
        },
        displayName: "notes.txt",
        digest,
        mediaHint: "text",
        support: "utf8_text",
      };
    },
    async retain() {},
    async discard() {},
    async close() {},
  };
  const composer = await createTurnComposer({ onChange() {}, stager });

  try {
    composer.setText("beforeafter");
    const before = composer.snapshot();
    const textElement = before.elements[0];
    expect(textElement).toMatchObject({ type: "text", text: "beforeafter" });
    if (textElement?.type !== "text") {
      throw new Error("Expected one canonical text element before staging.");
    }

    await composer.stage("/selected/notes.txt", {
      at: { elementId: textElement.elementId, offset: 6 },
      baseRevision: before.revision,
    });

    expect(composer.snapshot()).toMatchObject({
      elements: [
        { elementId: textElement.elementId, type: "text", text: "before" },
        { type: "resource", kind: "file", ordinal: 1 },
        { type: "text", text: "after" },
      ],
      renderedText: "before[File #1]after",
      resources: [
        {
          displayName: "notes.txt",
          kind: "file",
          ordinal: 1,
          state: "ready",
          token: "[File #1]",
        },
      ],
    });
  } finally {
    await composer.close();
  }
});

test("TurnComposer removes one atomic resource without renumbering and undo restores its identity", async () => {
  const stager: TurnComposerResourceStager = {
    async stage(input) {
      return {
        type: "staged_artifact",
        staged: {
          stagingId: input.id,
          id: digest,
          mediaType: "text/plain; charset=utf-8",
          byteCount: 5,
        },
        displayName: "notes.txt",
        digest,
        mediaHint: "text",
        support: "utf8_text",
      };
    },
    async retain() {},
    async discard() {},
    async close() {},
  };
  const composer = await createTurnComposer({ onChange() {}, stager });

  try {
    const firstId = await composer.stage("/selected/first.txt");
    await composer.stage("/selected/second.txt");

    await expect(composer.remove(firstId)).resolves.toBe(true);
    expect(composer.snapshot()).toMatchObject({
      renderedText: "[File #2]",
      resources: [{ ordinal: 2, token: "[File #2]" }],
    });

    const removed = composer.snapshot();
    await expect(composer.undo(removed.revision)).resolves.toBe(true);
    expect(composer.snapshot()).toMatchObject({
      renderedText: "[File #1][File #2]",
      resources: [
        { id: firstId, ordinal: 1, token: "[File #1]" },
        { ordinal: 2, token: "[File #2]" },
      ],
    });
  } finally {
    await composer.close();
  }
});

test("TurnComposer reserves cancellation for unsettled resource staging", async () => {
  const stager: TurnComposerResourceStager = {
    async stage(input) {
      return {
        type: "staged_artifact",
        staged: {
          stagingId: input.id,
          id: digest,
          mediaType: "text/plain; charset=utf-8",
          byteCount: 5,
        },
        displayName: "notes.txt",
        digest,
        mediaHint: "text",
        support: "utf8_text",
      };
    },
    async retain() {},
    async discard() {},
    async close() {},
  };
  const composer = await createTurnComposer({ onChange() {}, stager });

  try {
    const resourceId = await composer.stage("/selected/notes.txt");
    await expect(composer.cancel(resourceId)).resolves.toBe(false);
    expect(composer.snapshot().resources).toMatchObject([{ id: resourceId, state: "ready" }]);
  } finally {
    await composer.close();
  }
});

test("TurnComposer never reuses an ordinal until the draft is explicitly cleared", async () => {
  const stager: TurnComposerResourceStager = {
    async stage(input) {
      return {
        type: "staged_artifact",
        staged: {
          stagingId: input.id,
          id: digest,
          mediaType: "text/plain; charset=utf-8",
          byteCount: 5,
        },
        displayName: "notes.txt",
        digest,
        mediaHint: "text",
        support: "utf8_text",
      };
    },
    async retain() {},
    async discard() {},
    async close() {},
  };
  const composer = await createTurnComposer({ onChange() {}, stager });

  try {
    const firstId = await composer.stage("/selected/first.txt");
    await composer.stage("/selected/second.txt");
    await composer.remove(firstId);
    await composer.stage("/selected/third.txt");
    expect(composer.snapshot()).toMatchObject({
      renderedText: "[File #2][File #3]",
      resources: [{ ordinal: 2 }, { ordinal: 3 }],
    });

    await composer.clear();
    await composer.stage("/selected/fresh.txt");
    expect(composer.snapshot()).toMatchObject({
      renderedText: "[File #1]",
      resources: [{ ordinal: 1 }],
    });
  } finally {
    await composer.close();
  }
});

test("TurnComposer edits one text span without changing an adjacent resource identity", async () => {
  const stager: TurnComposerResourceStager = {
    async stage(input) {
      return {
        type: "staged_artifact",
        staged: {
          stagingId: input.id,
          id: digest,
          mediaType: "text/plain; charset=utf-8",
          byteCount: 5,
        },
        displayName: "notes.txt",
        digest,
        mediaHint: "text",
        support: "utf8_text",
      };
    },
    async retain() {},
    async discard() {},
    async close() {},
  };
  const composer = await createTurnComposer({ onChange() {}, stager });

  try {
    composer.setText("beforeafter");
    const initial = composer.snapshot();
    const initialText = initial.elements[0];
    if (initialText?.type !== "text") {
      throw new Error("Expected one canonical text element before staging.");
    }
    await composer.stage("/selected/notes.txt", {
      at: { elementId: initialText.elementId, offset: 6 },
      baseRevision: initial.revision,
    });
    const staged = composer.snapshot();
    const resource = staged.elements[1];
    const trailingText = staged.elements[2];
    if (resource?.type !== "resource" || trailingText?.type !== "text") {
      throw new Error("Expected text, resource, text after staging.");
    }

    await expect(
      composer.replaceText({
        baseRevision: staged.revision,
        document: [
          { type: "text", text: "before" },
          { type: "resource", elementId: resource.elementId },
          { type: "text", text: "new after" },
        ],
      }),
    ).resolves.toBe(true);
    expect(composer.snapshot()).toMatchObject({
      elements: [
        { type: "text", text: "before" },
        { elementId: resource.elementId, type: "resource", resourceId: resource.resourceId },
        { elementId: trailingText.elementId, type: "text", text: "new after" },
      ],
      renderedText: "before[File #1]new after",
    });
  } finally {
    await composer.close();
  }
});

test("TurnComposer bounds structured undo history without losing the newest edits", async () => {
  const stager: TurnComposerResourceStager = {
    async stage(input) {
      return {
        type: "staged_artifact",
        staged: {
          stagingId: input.id,
          id: digest,
          mediaType: "text/plain; charset=utf-8",
          byteCount: 5,
        },
        displayName: "notes.txt",
        digest,
        mediaHint: "text",
        support: "utf8_text",
      };
    },
    async retain() {},
    async discard() {},
    async close() {},
  };
  const composer = await createTurnComposer({ onChange() {}, stager });

  try {
    await composer.stage("/selected/notes.txt");
    const resource = composer.snapshot().elements[0];
    if (resource?.type !== "resource") {
      throw new Error("Expected one canonical resource element.");
    }
    for (let edit = 1; edit <= 101; edit += 1) {
      const snapshot = composer.snapshot();
      await expect(
        composer.replaceText({
          baseRevision: snapshot.revision,
          document: [
            { type: "resource", elementId: resource.elementId },
            { type: "text", text: `edit-${edit}` },
          ],
        }),
      ).resolves.toBe(true);
    }
    for (let undo = 0; undo < 100; undo += 1) {
      await expect(composer.undo(composer.snapshot().revision)).resolves.toBe(true);
    }
    expect(composer.snapshot().renderedText).toBe("[File #1]edit-1");
    await expect(composer.undo(composer.snapshot().revision)).resolves.toBe(false);
  } finally {
    await composer.close();
  }
});

test("TurnComposer seals the exact ordered draft without turning resource tokens into text authority", async () => {
  const stager: TurnComposerResourceStager = {
    async stage(input) {
      return {
        type: "staged_artifact",
        staged: {
          stagingId: input.id,
          id: digest,
          mediaType: "text/plain; charset=utf-8",
          byteCount: 5,
        },
        displayName: "notes.txt",
        digest,
        mediaHint: "text",
        support: "utf8_text",
      };
    },
    async retain() {},
    async discard() {},
    async close() {},
  };
  const composer = await createTurnComposer({ onChange() {}, stager });

  try {
    composer.setText("beforeafter");
    const initial = composer.snapshot();
    const initialText = initial.elements[0];
    if (initialText?.type !== "text") {
      throw new Error("Expected one canonical text element before staging.");
    }
    await composer.stage("/selected/notes.txt", {
      at: { elementId: initialText.elementId, offset: 6 },
      baseRevision: initial.revision,
    });

    const sealed = await composer.seal(new AbortController().signal);
    expect(sealed).toMatchObject({
      renderedText: "before[File #1]after",
      elements: [
        { type: "text", text: "before" },
        {
          type: "resource",
          kind: "file",
          ordinal: 1,
          token: "[File #1]",
          selection: { displayName: "notes.txt", support: "utf8_text" },
        },
        { type: "text", text: "after" },
      ],
    });
  } finally {
    await composer.close();
  }
});

test("TurnComposer captures and restores one recoverable ordered draft through retained artifacts", async () => {
  const retained: string[] = [];
  const pastedTexts = new Map<string, string>();
  const stager: TurnComposerResourceStager = {
    async stage(input) {
      return {
        type: "staged_artifact",
        staged: {
          stagingId: input.id,
          id: digest,
          mediaType: "text/plain; charset=utf-8",
          byteCount: 5,
        },
        displayName: "notes.txt",
        digest,
        mediaHint: "text",
        support: "utf8_text",
      };
    },
    async stageText(input) {
      pastedTexts.set(input.id, input.text);
      return {
        type: "staged_pasted_text",
        staged: {
          stagingId: input.id,
          id: digest,
          mediaType: "text/plain; charset=utf-8",
          byteCount: Buffer.byteLength(input.text, "utf8"),
        },
        digest,
        byteCount: Buffer.byteLength(input.text, "utf8"),
        lineCount: input.text.split("\n").length,
        scalarCount: Array.from(input.text).length,
      };
    },
    async readText(selection) {
      const pasted = pastedTexts.get(selection.staged.stagingId);
      if (pasted === undefined) {
        throw new Error("Expected retained pasted text.");
      }
      return pasted;
    },
    async retain(input) {
      retained.push(input.resourceId);
    },
    async discard() {},
    async close() {},
  };
  const composer = await createTurnComposer({ onChange() {}, stager });
  const recovered = await createTurnComposer({ onChange() {}, stager });

  try {
    composer.setText("beforeafter");
    const initial = composer.snapshot();
    const initialText = initial.elements[0];
    if (initialText?.type !== "text") {
      throw new Error("Expected one canonical text element before staging.");
    }
    await composer.stage("/selected/notes.txt", {
      at: { elementId: initialText.elementId, offset: 6 },
      baseRevision: initial.revision,
    });
    const pasted = Array.from({ length: 11 }, (_, index) => `legacy paste ${index + 1}`).join("\n");
    await composer.stagePastedText(pasted);

    const draft = await composer.captureDraft({
      type: "new_session",
      targetId: "deepseek-v4-flash.direct",
    });
    expect(draft.schemaVersion).toBe(2);
    expect(retained).toHaveLength(2);
    const legacyDraft: RecoverableTurnDraftV1 = {
      ...draft,
      schemaVersion: 1,
      elements: draft.elements as RecoverableTurnDraftV1["elements"],
    };
    await recovered.restoreDraft(legacyDraft);
    expect(recovered.snapshot()).toMatchObject({
      elements: [
        { type: "text", text: "before" },
        { type: "resource", ordinal: 1 },
        { type: "text", text: "after" },
        { type: "pasted_text", ordinal: 2 },
      ],
      renderedText: "before[File #1]after[Text #2]",
      resources: [{ displayName: "notes.txt", ordinal: 1, state: "ready" }],
      pastedTexts: [{ ordinal: 2, state: "ready" }],
    });
    expect(recovered.readExpandedText()).toBe(`before[File #1]after${pasted}`);
  } finally {
    await recovered.close();
    await composer.close();
  }
});
