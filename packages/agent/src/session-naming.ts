const maximumSessionTitleGraphemes = 60;

export function sessionTitleFallback(input: string): string {
  return normalizedSessionTitle(input) ?? "New session";
}

export function normalizedSessionTitle(input: string): string | null {
  const withoutTerminalSequences = stripTerminalSequences(input);
  let printable = "";
  for (const character of withoutTerminalSequences) {
    const codePoint = character.codePointAt(0) ?? 0;
    printable += codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
  }
  const normalized = printable.trim().split(/\s+/u).filter(Boolean).join(" ");
  if (normalized.length === 0) {
    return null;
  }
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  return [...segmenter.segment(normalized)]
    .slice(0, maximumSessionTitleGraphemes)
    .map(({ segment }) => segment)
    .join("")
    .trim();
}

function stripTerminalSequences(input: string): string {
  let output = "";
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code !== 0x1b) {
      output += input[index] ?? "";
      continue;
    }
    const introducer = input.charCodeAt(index + 1);
    if (introducer === 0x5b) {
      index += 2;
      while (index < input.length) {
        const candidate = input.charCodeAt(index);
        if (candidate >= 0x40 && candidate <= 0x7e) {
          break;
        }
        index += 1;
      }
      continue;
    }
    if (introducer === 0x5d) {
      index += 2;
      while (index < input.length) {
        if (input.charCodeAt(index) === 0x07) {
          break;
        }
        if (input.charCodeAt(index) === 0x1b && input.charCodeAt(index + 1) === 0x5c) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return output;
}
