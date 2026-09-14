import { Editor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
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

for (const width of [40, 80, 120]) {
  test.each([false, true])(
    `long image path atoms wrap and retain color and atomic movement at ${width} columns, noColor=%s`,
    (noColor) => {
      const editor = new Editor(
        { requestRender() {}, terminal: { rows: 40 } } as never,
        createAdamTuiTheme(noColor).editor,
      ) as AtomEditor;
      const label = `[Image #1](assets/${"nested/".repeat(20)}截图 (1).png)`;
      const parts: readonly DocumentPart[] = [{ type: "atom", id: "image", label }];
      const intents: EditIntent[] = [];
      editor.onEditIntent = (intent) => intents.push(intent);
      editor.setDocument(parts, { partId: "image", edge: "after" });
      const lines = editor.render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(editor.getText()).toBe(label);
      expect(lines.map(stripTerminalSequences).join("").replaceAll(" ", "")).toContain(
        label.replaceAll(" ", ""),
      );
      if (noColor) expect(lines.join("")).not.toContain("\u001b[38;2;137;220;235m");
      else {
        const colored = lines
          .join("")
          .split("\u001b[38;2;137;220;235m")
          .slice(1)
          .map((part) => part.split("\u001b[39m")[0])
          .join("");
        expect(colored).toBe(label);
      }
      editor.handleInput("\u001b[D");
      expect(editor.getDocumentCursor()).toEqual({ partId: "image", edge: "before" });
      editor.handleInput("\u001b[C");
      expect(editor.getDocumentCursor()).toEqual({ partId: "image", edge: "after" });
      editor.handleInput("\u007f");
      expect(intents.at(-1)).toEqual({
        type: "remove_atom",
        atomId: "image",
        direction: "backward",
      });
      expect(editor.getText()).toBe("");
      editor.setDocument(parts, { partId: "image", edge: "before" });
      editor.handleInput("\u001b[3~");
      expect(intents.at(-1)).toEqual({
        type: "remove_atom",
        atomId: "image",
        direction: "forward",
      });
      expect(editor.getText()).toBe("");
    },
  );
}

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

test("Pi Editor styles only structural atom ranges without changing visible text", () => {
  const editor = new Editor(
    { requestRender() {}, terminal: { rows: 24 } } as never,
    createAdamTuiTheme(false).editor,
  ) as AtomEditor;
  editor.setDocument(
    [
      { type: "text", id: "literal", text: "literal [File #1] " },
      { type: "atom", id: "resource", label: "[File #1]" },
    ],
    { partId: "resource", edge: "after" },
  );

  const rendered = editor.render(80).join("\n");
  expect(rendered).toContain("literal [File #1] ");
  expect(rendered.split("\u001b[38;2;137;220;235m[File #1]\u001b[39m").length - 1).toBe(1);
  expect(editor.getText()).toBe("literal [File #1] [File #1]");
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
