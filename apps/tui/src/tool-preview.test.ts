import type { ToolPreviewDisplay } from "@adam-agent/presentation";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { createAdamTuiTheme } from "./theme.js";
import { ToolPreview } from "./tool-preview.js";

test("ToolPreview shows ten numbered code lines before the global expansion", () => {
  const preview: ToolPreviewDisplay = {
    kind: "read_text",
    language: "typescript",
    lines: Array.from({ length: 12 }, (_, index) => ({
      number: index + 1,
      text: `const value${index + 1} = ${index + 1};`,
    })),
    omittedBytes: 0,
    sourceTruncated: false,
  };

  const collapsed = new ToolPreview(preview, false, createAdamTuiTheme(true)).render(64);
  expect(collapsed.join("\n")).toContain(" 1 │ const value1 = 1;");
  expect(collapsed.join("\n")).toContain("10 │ const value10 = 10;");
  expect(collapsed.join("\n")).not.toContain("value11");
  expect(collapsed.join("\n")).toContain("2 more projected lines · Ctrl+O expand");

  const expanded = new ToolPreview(preview, true, createAdamTuiTheme(true)).render(32);
  expect(expanded.join("\n")).toContain("12 │ const value12 = 12;");
  expect(expanded.every((line) => visibleWidth(line) <= 32)).toBe(true);
});

test("ToolPreview keeps separate shell streams and a five-line collapsed tail", () => {
  const preview: ToolPreviewDisplay = {
    kind: "shell_output",
    termination: { type: "exited", exitCode: 0 },
    stdout: {
      text: "one\ntwo\nthree\nfour\nfive\nsix\nseven",
      totalBytes: 33,
      omittedBytes: 9,
    },
    stderr: { text: "warning", totalBytes: 7, omittedBytes: 0 },
  };

  const collapsed = new ToolPreview(preview, false, createAdamTuiTheme(true)).render(48);
  expect(collapsed.join("\n")).toContain("stdout · 9 earlier bytes omitted");
  expect(collapsed).not.toContain("one");
  expect(collapsed).not.toContain("two");
  expect(collapsed).toContain("three");
  expect(collapsed).toContain("seven");
  expect(collapsed).toContain("stderr");
  expect(collapsed).toContain("warning");

  const expanded = new ToolPreview(preview, true, createAdamTuiTheme(true)).render(48);
  expect(expanded).toContain("one");
  expect(expanded).toContain("two");
});

test("ToolPreview maps syntax and diff roles through Catppuccin Mocha", () => {
  const code: ToolPreviewDisplay = {
    kind: "write_text",
    language: "typescript",
    lines: [{ number: 1, text: "const answer: number = 42;" }],
    omittedBytes: 0,
  };
  const diff: ToolPreviewDisplay = {
    kind: "diff",
    language: "text",
    lines: [
      { kind: "deletion", oldLineNumber: null, newLineNumber: null, text: "before" },
      { kind: "addition", oldLineNumber: null, newLineNumber: null, text: "after" },
    ],
    omittedBytes: 0,
  };
  const theme = createAdamTuiTheme(false);

  expect(new ToolPreview(code, false, theme).render(40).join("\n")).toContain(
    "\u001b[38;2;203;166;247mconst",
  );
  expect(new ToolPreview(diff, false, theme).render(40).join("\n")).toContain(
    "\u001b[38;2;243;139;168m-",
  );
  expect(new ToolPreview(diff, false, theme).render(40).join("\n")).toContain(
    "\u001b[38;2;166;227;161m+",
  );
});

test("ToolPreview keeps CJK width bounded and strips untrusted terminal controls", () => {
  const preview: ToolPreviewDisplay = {
    kind: "read_text",
    language: "typescript",
    lines: [{ number: 1, text: 'const 标题 = "\u001b[2J内容";' }],
    omittedBytes: 0,
    sourceTruncated: false,
  };

  const rendered = new ToolPreview(preview, false, createAdamTuiTheme(true)).render(20);
  expect(rendered.join("\n")).toContain("const 标题");
  expect(rendered.join("\n")).not.toContain("\u001b[2J");
  expect(rendered.every((line) => visibleWidth(line) <= 20)).toBe(true);
});
