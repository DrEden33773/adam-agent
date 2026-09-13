export type ImageMention = { readonly start: number; readonly end: number; readonly path: string };

export function isImageMentionPath(path: string): boolean {
  return /\.(?:png|jpe?g)$/iu.test(path);
}

// Scan only user prose. Keep code, escapes and semantic non-path atoms inert.
export function findImageMentions(
  text: string,
  selectedPaths: readonly ImageMention[] = [],
): ImageMention[] {
  const selected = new Map(selectedPaths.map((path) => [path.start, path]));
  const found: ImageMention[] = [];
  let fence: { character: string; length: number } | undefined;
  let inlineTicks = 0;
  for (let i = 0; i < text.length; ) {
    if (i === 0 || text[i - 1] === "\n") {
      const marker =
        /^(?: {0,3}>[ \t]?)*(?: {0,3}(?:[-+*]|\d+[.)])[ \t]+)? {0,3}(`{3,}|~{3,})([^\n]*)/u.exec(
          text.slice(i),
        );
      if (marker !== null) {
        const run = marker[1] ?? "";
        if (fence === undefined && inlineTicks === 0)
          fence = { character: run[0] ?? "", length: run.length };
        else if (
          fence !== undefined &&
          run[0] === fence.character &&
          run.length >= fence.length &&
          marker[2]?.trim() === ""
        )
          fence = undefined;
        i += marker[0].length;
        continue;
      }
      if (/^(?: {4}|\t)/u.test(text.slice(i))) {
        const end = text.indexOf("\n", i);
        i = end < 0 ? text.length : end + 1;
        continue;
      }
    }
    if (fence !== undefined) {
      i += 1;
      continue;
    }
    if (text[i] === "\\" && inlineTicks === 0) {
      i += 2;
      continue;
    }
    if (text[i] === "`") {
      let end = i + 1;
      while (text[end] === "`") end += 1;
      const length = end - i;
      if (inlineTicks === length) inlineTicks = 0;
      else if (
        inlineTicks === 0 &&
        [...text.slice(end).matchAll(/`+/gu)].some((run) => run[0].length === length)
      )
        inlineTicks = length;
      i = end;
      continue;
    }
    const atom = selected.get(i);
    if (atom !== undefined) {
      if (inlineTicks === 0 && isImageMentionPath(atom.path)) found.push(atom);
      i = atom.end;
      continue;
    }
    if (
      inlineTicks !== 0 ||
      text[i] !== "@" ||
      (i > 0 && !/[\s([{，。：；！？]/u.test(text[i - 1] ?? ""))
    ) {
      i += 1;
      continue;
    }
    const start = i;
    const quote = text[i + 1];
    let end: number;
    let path: string;
    if (quote === '"' || quote === "'") {
      end = text.indexOf(quote, i + 2);
      if (end < 0) {
        i += 1;
        continue;
      }
      path = text.slice(i + 2, end);
      end += 1;
    } else {
      const token = /^[^\s`<>"'\uFFFC]+/u.exec(text.slice(i + 1))?.[0] ?? "";
      path = token.replace(/[),.;:!?\]}，。；：！？]+$/u, "");
      end = i + 1 + path.length;
    }
    if (isImageMentionPath(path) && !/[\r\n\0]/u.test(path) && !path.includes("://"))
      found.push({ start, end, path });
    i = Math.max(i + 1, end);
  }
  return found;
}
