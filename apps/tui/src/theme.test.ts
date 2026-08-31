import { expect, test } from "vitest";
import { createAdamTuiTheme } from "./theme.js";

test("Catppuccin semantic slots retain the frozen completion and reference colors", () => {
  const theme = createAdamTuiTheme(false);
  expect(theme.text("text")).toBe("\u001b[38;2;205;214;244mtext\u001b[39m");
  expect(theme.green("green")).toBe("\u001b[38;2;166;227;161mgreen\u001b[39m");
  expect(theme.overlay("overlay")).toBe("\u001b[38;2;108;112;134moverlay\u001b[39m");
  expect(theme.editor.selectList.selectedText("selected")).toBe(
    "\u001b[38;2;203;166;247mselected\u001b[39m",
  );
  expect(theme.reference("reference")).toBe("\u001b[38;2;137;220;235mreference\u001b[39m");
});

test("NO_COLOR preserves semantic content without SGR", () => {
  const theme = createAdamTuiTheme(true);
  expect([
    theme.text("text"),
    theme.green("green"),
    theme.overlay("overlay"),
    theme.editor.selectList.selectedText("> selected"),
    theme.reference("reference"),
  ]).toEqual(["text", "green", "overlay", "> selected", "reference"]);
});
