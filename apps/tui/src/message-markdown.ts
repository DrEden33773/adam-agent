import { Markdown } from "@earendil-works/pi-tui";
import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

export function createMessageMarkdown(text: string, theme: AdamTuiTheme): Markdown {
  return new Markdown(
    protectBareEvidence(safeTerminalText(text)),
    0,
    0,
    theme.markdown,
    undefined,
    { preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
  );
}

/** Keep unfenced evidence blocks literal without disabling Markdown elsewhere in the answer. */
export function protectBareEvidence(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let fence: { character: string; length: number } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence !== undefined) {
      result.push(line);
      if (
        marker?.[1]?.[0] === fence.character &&
        marker[1].length >= fence.length &&
        marker[2]?.trim() === ""
      )
        fence = undefined;
      continue;
    }
    if (marker?.[1] !== undefined) {
      fence = { character: marker[1][0] ?? "`", length: marker[1].length };
      result.push(line);
      continue;
    }
    if (!/^(?:diff --git |@@ |--- |\+\+\+ |#!|\$ |\d{4}-\d\d-\d\d[T ])/u.test(line)) {
      result.push(line);
      continue;
    }
    const kind = /^(?:#!|\$ )/u.test(line) ? "shell" : /^\d{4}-/u.test(line) ? "log" : "diff";
    const literal = [line];
    while (index + 1 < lines.length) {
      const next = lines[index + 1] ?? "";
      if (/^ {0,3}(?:`{3,}|~{3,})/u.test(next)) break;
      if (kind === "shell") {
        // Blank lines are valid source. Explicit Markdown starts a new section after a blank.
        if (literal.at(-1)?.trim() === "" && /^(?:#{1,6}\s|(?:\*\*|__)\S)/u.test(next)) break;
      } else if (kind === "log") {
        if (!/^(?:\d{4}-\d\d-\d\d[T ]|[ \t]+\S|at )/u.test(next)) break;
      } else if (
        !/^(?:[ +\-\\]|@@|diff --git |index |(?:new|deleted) file mode |(?:old|new) mode |(?:dis)?similarity index |(?:rename|copy) (?:from|to) |$)/u.test(
          next,
        )
      )
        break;
      literal.push(next);
      index += 1;
    }
    const delimiter = "~".repeat(
      Math.max(
        3,
        ...literal.flatMap((entry) =>
          [...entry.matchAll(/~+/gu)].map((match) => match[0].length + 1),
        ),
      ),
    );
    result.push(`${delimiter}text`, ...literal, delimiter);
  }
  return result.join("\n");
}
