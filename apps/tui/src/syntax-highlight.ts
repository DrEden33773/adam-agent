import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

/**
 * Bounded language registration and theme-scope projection are adapted from the observable
 * strategy in badlogic/pi-mono commit dcd461925db2edf69a43c8135db1180d418afd54 (MIT).
 * See THIRD_PARTY_NOTICES.md.
 */
const languages = {
  bash,
  c,
  cpp,
  csharp,
  css,
  go,
  html: xml,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  python,
  ruby,
  rust,
  sql,
  typescript,
  yaml,
};

for (const [name, language] of Object.entries(languages)) {
  hljs.registerLanguage(name, language);
}

export function highlightCodeLines(
  lines: readonly string[],
  language: string | null,
  theme: AdamTuiTheme,
): readonly string[] {
  const safeLines = lines.map((line) => safeTerminalText(line));
  if (language === null || language === "text" || hljs.getLanguage(language) === undefined) {
    return safeLines.map((line) => theme.syntax.default(line));
  }
  try {
    const html = hljs.highlight(safeLines.join("\n"), {
      language,
      ignoreIllegals: true,
    }).value;
    return renderHighlightedLines(html, theme);
  } catch {
    return safeLines.map((line) => theme.syntax.default(line));
  }
}

function renderHighlightedLines(html: string, theme: AdamTuiTheme): readonly string[] {
  const lines = [""];
  const scopes: Array<string | undefined> = [];
  let index = 0;
  const append = (text: string) => {
    const formatter = activeFormatter(scopes, theme);
    const parts = text.split("\n");
    for (const [partIndex, part] of parts.entries()) {
      if (part.length > 0) {
        lines[lines.length - 1] += formatter?.(part) ?? part;
      }
      if (partIndex < parts.length - 1) {
        lines.push("");
      }
    }
  };
  while (index < html.length) {
    if (html.startsWith("<span", index)) {
      const end = html.indexOf(">", index + 5);
      if (end >= 0) {
        const tag = html.slice(index, end + 1);
        scopes.push(/class=["']hljs-([^"']+)["']/u.exec(tag)?.[1]);
        index = end + 1;
        continue;
      }
    }
    if (html.startsWith("</span>", index)) {
      scopes.pop();
      index += "</span>".length;
      continue;
    }
    if (html[index] === "&") {
      const entity = decodeEntity(html, index);
      if (entity !== null) {
        append(entity.text);
        index += entity.length;
        continue;
      }
    }
    const nextTag = html.indexOf("<", index);
    const nextEntity = html.indexOf("&", index);
    const candidates = [nextTag, nextEntity].filter((candidate) => candidate >= 0);
    const end = candidates.length === 0 ? html.length : Math.min(...candidates);
    if (end === index) {
      append(html[index] ?? "");
      index += 1;
      continue;
    }
    append(html.slice(index, end));
    index = end;
  }
  return lines;
}

function activeFormatter(
  scopes: readonly (string | undefined)[],
  theme: AdamTuiTheme,
): ((text: string) => string) | undefined {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    const scope = scopes[index];
    if (scope === undefined) {
      continue;
    }
    const exact = theme.syntax[scope];
    if (exact !== undefined) {
      return exact;
    }
    const prefix = scope.split(/[.-]/u)[0];
    if (prefix !== undefined && theme.syntax[prefix] !== undefined) {
      return theme.syntax[prefix];
    }
  }
  return theme.syntax.default;
}

function decodeEntity(
  html: string,
  index: number,
): { readonly text: string; readonly length: number } | null {
  const match = /^&(amp|lt|gt|quot|#39|#x[0-9a-f]+|#[0-9]+);/iu.exec(html.slice(index));
  if (match === null) {
    return null;
  }
  const entity = match[1];
  if (entity === undefined) {
    return null;
  }
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    "#39": "'",
  };
  const namedText = named[entity];
  const codePoint = entity.startsWith("#x")
    ? Number.parseInt(entity.slice(2), 16)
    : Number.parseInt(entity.slice(1), 10);
  const text = namedText ?? (Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : null);
  if (text === null) {
    return null;
  }
  return { text, length: match[0].length };
}
