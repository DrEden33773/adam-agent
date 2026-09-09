import { Editor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { AdamAutocompleteProvider } from "./command-autocomplete.js";
import { createAdamStructuredEditorCompletion } from "./structured-editor-completion.js";
import { createAdamTuiTheme } from "./theme.js";

for (const width of [40, 80, 120]) {
  for (const noColor of [false, true]) {
    test(`selected completion identifies same-name CJK paths at ${width} columns, noColor=${noColor}`, async () => {
      const accepted: string[] = [];
      const provider = new AdamAutocompleteProvider({
        getProjectPaths: () => ["文档/一/说明.md", "文档/二/说明.md"],
        getRunActive: () => false,
        getSkills: () => [],
      });
      const editor = await openMenu(provider, "Review @说明", width, noColor, (editor) => {
        editor.setStructuredCompletion(
          createAdamStructuredEditorCompletion({ onPathAtom: (path) => accepted.push(path.path) }),
        );
      });
      expect(screen(editor, width)).toContain("[File] 文档/一/说明.md");
      editor.handleInput("\u001b[B");
      expect(screen(editor, width)).toContain("[File] 文档/二/说明.md");
      expect(editor.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
      editor.handleInput("\t");
      expect(accepted).toEqual(["文档/二/说明.md"]);
      expect(editor.getText()).toBe("Review @文档/二/说明.md");
      const undo: string[] = [];
      editor.onEditIntent = (intent) => undo.push(intent.type);
      editor.handleInput(String.fromCharCode(31));
      expect(undo).toEqual(["undo"]);
    });

    test(`selected completion identifies same-name Skill sources at ${width} columns, noColor=${noColor}`, async () => {
      const accepted: string[] = [];
      const provider = new AdamAutocompleteProvider({
        getProjectPaths: () => [],
        getRunActive: () => false,
        getSkills: () => [
          {
            name: "audit",
            description: "检查 e\u0301 与代码",
            qualifiedId: "skill:v1:project:.:audit",
            source: { type: "project", scope: "." },
          },
          {
            name: "audit",
            description: "用户检查",
            qualifiedId: "skill:v1:user:audit",
            source: { type: "user" },
          },
        ],
      });
      const editor = await openMenu(provider, "Use $au", width, noColor, (editor) => {
        editor.setStructuredCompletion(
          createAdamStructuredEditorCompletion({
            onSkillAtom: (skill) => accepted.push(skill.qualifiedId),
          }),
        );
      });
      expect(screen(editor, width)).toContain("project:. · 检查 e\u0301 与代码");
      editor.handleInput("\u001b[B");
      expect(screen(editor, width)).toContain("user · 用户检查");
      expect(editor.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
      editor.handleInput("\t");
      expect(accepted).toEqual(["skill:v1:user:audit"]);
      expect(editor.getText()).toBe("Use $audit");
      const undo: string[] = [];
      editor.onEditIntent = (intent) => undo.push(intent.type);
      editor.handleInput(String.fromCharCode(31));
      expect(undo).toEqual(["undo"]);
    });
  }
}

test("narrow selected details fit short terminal height and mark clipped descriptions", async () => {
  const provider = new AdamAutocompleteProvider({
    getProjectPaths: () => [],
    getRunActive: () => false,
    getSkills: () => [
      {
        name: "audit",
        description: "检查代码与组合字符 e\u0301 ".repeat(100),
        qualifiedId: "skill:v1:user:audit",
        source: { type: "user" },
      },
    ],
  });
  const editor = await openMenu(provider, "$au", 40, true, () => {}, 6);
  expect(screen(editor, 40)).toContain("user · 检查");
  expect(screen(editor, 40)).toContain("…");
  expect(editor.render(40)).toHaveLength(6);
  expect(editor.render(40).every((line) => visibleWidth(line) <= 40)).toBe(true);
});

for (const width of [40, 80, 120]) {
  test(`Agent alias identifies its exact thread at ${width} columns`, async () => {
    const accepted: unknown[] = [];
    const provider = new AdamAutocompleteProvider({
      getProjectPaths: () => ["文档/审查"],
      getRunActive: () => false,
      getSkills: () => [],
      getThreads: () => [
        {
          parentSessionId: "main-session",
          lifecycle: "open",
          displayName: "审查",
          handle: "@agent-7",
          alias: "审查",
          residency: "live",
          threadId: "thread-7",
          role: "general",
          description: "检查代码",
          turn: {
            turnId: "turn-7",
            attemptId: "attempt-7",
            childSessionId: "child-7",
            phase: "idle",
            waitReason: "none",
            ownerPhase: "released",
            lastOutcome: "completed",
            label: "Done",
            recovery: "none",
            health: "healthy",
          },
        },
      ],
    });
    const editor = await openMenu(provider, "Ask @审", width, true, (editor) => {
      editor.setStructuredCompletion(
        createAdamStructuredEditorCompletion({
          onMentionAtom: (mention) => accepted.push(mention),
        }),
      );
    });
    expect(screen(editor, width)).toContain("[Agent] @agent-7");
    editor.handleInput("\t");
    expect(accepted).toEqual([
      expect.objectContaining({
        kind: "agent",
        threadId: "thread-7",
        parentSessionId: "main-session",
        literal: "@审查",
      }),
    ]);
    expect(editor.getText()).toBe("Ask @审查");
  });
}

function screen(editor: Editor, width: number): string {
  return editor.render(width).map(stripTerminalSequences).join("\n");
}

async function openMenu(
  provider: AdamAutocompleteProvider,
  draft: string,
  width: number,
  noColor: boolean,
  configure: (editor: Editor) => void,
  rows = 30,
): Promise<Editor> {
  const ready = Promise.withResolvers<void>();
  const editor = new Editor(
    {
      terminal: { rows },
      requestRender() {
        if (screen(editor, width).includes("> ")) ready.resolve();
      },
    } as never,
    createAdamTuiTheme(noColor).editor,
  );
  configure(editor);
  editor.setAutocompleteProvider(provider);
  editor.setText(draft);
  editor.refreshAutocomplete();
  await ready.promise;
  return editor;
}
