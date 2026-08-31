import { Editor } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";

import { createAdamTuiTheme } from "./theme.js";

type DocumentPart =
  | { readonly type: "text"; readonly id: string; readonly text: string }
  | { readonly type: "atom"; readonly id: string; readonly label: string };

type DocumentPoint =
  | { readonly partId: string; readonly offset: number }
  | { readonly partId: string; readonly edge: "before" | "after" };

type EditIntent =
  | {
      readonly type: "replace";
      readonly range: { readonly anchor: DocumentPoint; readonly focus: DocumentPoint };
      readonly text: string;
      readonly document: readonly DocumentPart[];
    }
  | { readonly type: "remove_atom"; readonly atomId: string; readonly direction: string }
  | { readonly type: "undo" };

type AtomEditor = Editor & {
  onEditIntent?: (intent: EditIntent) => void;
  getDocumentCursor(): DocumentPoint;
  setDocument(parts: readonly DocumentPart[], cursor?: DocumentPoint): void;
};

test("Pi Editor treats one host-owned resource label as an atomic navigable part", () => {
  const editor = new Editor(
    { requestRender() {} } as never,
    createAdamTuiTheme(true).editor,
  ) as AtomEditor;
  const intents: EditIntent[] = [];
  editor.onEditIntent = (intent) => intents.push(intent);
  const parts: readonly DocumentPart[] = [
    { type: "text", id: "left", text: "before" },
    { type: "atom", id: "resource", label: "[File #1]" },
    { type: "text", id: "right", text: "after" },
  ];

  editor.setDocument(parts, { partId: "resource", edge: "before" });
  editor.handleInput("\u001b[C");
  expect(editor.getDocumentCursor()).toEqual({ partId: "resource", edge: "after" });

  editor.handleInput("\u007f");
  expect(intents).toEqual([{ type: "remove_atom", atomId: "resource", direction: "backward" }]);
  expect(editor.getText()).toBe("beforeafter");
  expect(editor.getDocumentCursor()).toEqual({ partId: "left", offset: 6 });

  editor.setDocument(parts, { partId: "right", offset: 0 });
  editor.handleInput("!");
  editor.handleInput(String.fromCharCode(31));
  expect(intents.slice(1)).toEqual([
    {
      type: "replace",
      range: {
        anchor: { partId: "right", offset: 0 },
        focus: { partId: "right", offset: 0 },
      },
      text: "!",
      document: [
        { type: "text", id: "left", text: "before" },
        { type: "atom", id: "resource", label: "[File #1]" },
        { type: "text", id: "right", text: "!after" },
      ],
    },
    { type: "undo" },
  ]);
});

test("Pi Editor rejects unsupported structured mutations without changing its document", () => {
  const editor = new Editor(
    { requestRender() {} } as never,
    createAdamTuiTheme(true).editor,
  ) as AtomEditor;
  const intents: EditIntent[] = [];
  editor.onEditIntent = (intent) => intents.push(intent);
  editor.setDocument(
    [
      { type: "atom", id: "resource", label: "[File #1]" },
      { type: "text", id: "right", text: "after" },
    ],
    { partId: "right", offset: 5 },
  );

  editor.handleInput(String.fromCharCode(23));

  expect(editor.getText()).toBe("[File #1]after");
  expect(editor.getDocumentCursor()).toEqual({ partId: "right", offset: 5 });
  expect(intents).toEqual([]);
});

test("Pi Editor deletes the last adjacent text grapheme without losing its atom cursor", () => {
  const editor = new Editor(
    { requestRender() {} } as never,
    createAdamTuiTheme(true).editor,
  ) as AtomEditor;
  const intents: EditIntent[] = [];
  editor.onEditIntent = (intent) => intents.push(intent);
  editor.setDocument(
    [
      { type: "atom", id: "resource", label: "[File #1]" },
      { type: "text", id: "right", text: "x" },
    ],
    { partId: "right", offset: 1 },
  );

  editor.handleInput("\u007f");

  expect(editor.getText()).toBe("[File #1]");
  expect(editor.getDocumentCursor()).toEqual({ partId: "resource", edge: "after" });
  expect(intents).toMatchObject([
    {
      type: "replace",
      document: [{ type: "atom", id: "resource", label: "[File #1]" }],
      text: "",
    },
  ]);
});
