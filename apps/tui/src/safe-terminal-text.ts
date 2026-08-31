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
    } else if (!isUnsafePresentationControl(codePoint)) {
      result += character;
    }
  }
  return result;
}

import { isUnsafePresentationControl, stripTerminalSequences } from "@adam-agent/presentation";
