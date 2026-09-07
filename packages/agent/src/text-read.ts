import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";

export const textReadInputSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  startLine: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  maxLines: z.number().int().min(1).max(2000).optional(),
  byteOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  expectedFileVersion: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/u)
    .optional(),
});

export const textReadOutputSchema = z.strictObject({
  path: z.string(),
  content: z.string(),
  truncated: z.boolean(),
  reason: z.enum(["eof", "line_limit", "output_limit", "scan_limit"]),
  fileVersion: z.string(),
  byteRange: z.strictObject({ start: z.number(), endExclusive: z.number() }),
  lineRange: z.strictObject({ start: z.number(), endInclusive: z.number() }).nullable(),
  nextRead: textReadInputSchema.required().nullable(),
});

export class TextReadError extends Error {
  constructor(
    readonly code: "invalid_tool_input" | "tool_io_failed" | "binary_file",
    message: string,
  ) {
    super(message);
  }
}

// Limits apply to source reads as well as the complete JSON result, including escaping.
export async function readTextRange(
  targetPath: string,
  input: z.infer<typeof textReadInputSchema>,
  signal: AbortSignal,
): Promise<z.infer<typeof textReadOutputSchema>> {
  const file = await open(
    targetPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    signal.throwIfAborted();
    const before = await file.stat({ bigint: true });
    if (!before.isFile())
      throw new TextReadError("invalid_tool_input", "path must identify a regular text file.");
    const version = (stat: typeof before) =>
      `sha256:${createHash("sha256").update([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")).digest("hex")}`;
    const fileVersion = version(before);
    if (input.expectedFileVersion !== undefined && input.expectedFileVersion !== fileVersion) {
      throw new TextReadError(
        "invalid_tool_input",
        "The file changed. Restart the read without byteOffset or expectedFileVersion.",
      );
    }
    let position = input.byteOffset ?? 0;
    if (position > Number(before.size))
      throw new TextReadError("invalid_tool_input", "byteOffset exceeds EOF. Restart the read.");
    let skip = (input.startLine ?? 1) - 1;
    let start = position;
    let lines = 0;
    let scanned = 0;
    let content = "";
    let outputBytes = 0;
    const contentBudget = 64 * 1024 - 2 * Buffer.byteLength(JSON.stringify(input.path)) - 2048;
    let reason: "eof" | "line_limit" | "output_limit" | "scan_limit" = "eof";
    const maximumLines = input.maxLines ?? 200;
    const buffer = Buffer.alloc(16 * 1024 + 4);
    outer: while (position < Number(before.size)) {
      signal.throwIfAborted();
      if (scanned >= 8 * 1024 * 1024) {
        reason = "scan_limit";
        break;
      }
      const { bytesRead } = await file.read(buffer, 0, 16 * 1024, position);
      if (bytesRead === 0) break;
      scanned += bytesRead;
      // Leave a partial trailing UTF-8 code point for the next bounded read.
      let end = bytesRead;
      if (position + bytesRead < Number(before.size)) {
        let lead = bytesRead - 1;
        while (lead >= 0 && ((buffer[lead] ?? 0) & 0xc0) === 0x80) lead--;
        const byte = buffer[lead] ?? 0;
        const width = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
        if (lead + width > bytesRead) end = lead;
      }
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          buffer.subarray(0, end),
        );
      } catch {
        throw new TextReadError(
          "binary_file",
          "The selected range is not valid UTF-8. Use a returned nextRead position.",
        );
      }
      for (const character of decoded) {
        if (character === "\0")
          throw new TextReadError("binary_file", "The selected range contains binary data.");
        const bytes = Buffer.byteLength(character);
        if (skip > 0) {
          position += bytes;
          start = position;
          if (character === "\n") skip--;
          continue;
        }
        const cost = Buffer.byteLength(JSON.stringify(character)) - 2;
        if (outputBytes + cost > contentBudget) {
          reason = "output_limit";
          break outer;
        }
        content += character;
        outputBytes += cost;
        position += bytes;
        if (character === "\n" && ++lines >= maximumLines) {
          reason = "line_limit";
          break outer;
        }
      }
    }
    signal.throwIfAborted();
    if (version(await file.stat({ bigint: true })) !== fileVersion) {
      throw new TextReadError(
        "tool_io_failed",
        "The file changed while reading. Restart the read.",
      );
    }
    const truncated = position < Number(before.size);
    if (!truncated) reason = "eof";
    const returnedLines = lines + (content.length > 0 && !content.endsWith("\n") ? 1 : 0);
    return {
      path: input.path,
      content,
      truncated,
      reason,
      fileVersion,
      byteRange: { start, endExclusive: position },
      lineRange:
        input.byteOffset === undefined && returnedLines > 0
          ? {
              start: input.startLine ?? 1,
              endInclusive: (input.startLine ?? 1) + returnedLines - 1,
            }
          : null,
      nextRead: truncated
        ? {
            path: input.path,
            byteOffset: position,
            startLine: skip + 1,
            maxLines: maximumLines,
            expectedFileVersion: fileVersion,
          }
        : null,
    };
  } finally {
    await file.close();
  }
}
