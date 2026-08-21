/**
 * Converts untrusted durable/runtime text into printable terminal content.
 * Pi owns terminal control sequences; presented content never does.
 */
export function safeTerminalText(value: string): string {
  let result = "";
  for (const character of stripTerminalSequences(value)) {
    const codePoint = character.codePointAt(0) as number;
    if (character === "\n") {
      result += character;
    } else if (character === "\r") {
      result += "\n";
    } else if (character === "\t") {
      result += "  ";
    } else if (
      codePoint >= 0x20 &&
      !(codePoint >= 0x7f && codePoint <= 0x9f) &&
      !isBidirectionalControl(codePoint)
    ) {
      result += character;
    }
  }
  return result;
}

function isBidirectionalControl(codePoint: number): boolean {
  return (
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

import { stripTerminalSequences } from "@earendil-works/pi-tui";
