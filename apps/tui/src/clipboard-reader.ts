import type { ClipboardImageReader } from "./linux-clipboard-image.js";

export type ClipboardReadResult =
  | {
      readonly status: "image";
      readonly bytes: Uint8Array;
      readonly platform: "linux_wayland" | "linux_x11" | "wsl_bridge";
    }
  | {
      readonly status: "text";
      readonly platform: "linux_wayland" | "linux_x11" | "wsl_bridge";
      readonly text: string;
    }
  | {
      readonly status: "empty" | "failed" | "file_drop" | "unsupported";
      readonly message: string;
    };

export type ClipboardReader = {
  readClipboard(signal: AbortSignal): Promise<ClipboardReadResult>;
  close(): Promise<void>;
};

export type ClipboardTextReadResult =
  | {
      readonly status: "read";
      readonly platform: "linux_wayland" | "linux_x11" | "wsl_bridge";
      readonly text: string;
    }
  | { readonly status: "empty" | "failed" | "unsupported"; readonly message: string };

export type ClipboardTextReader = {
  readText(signal: AbortSignal): Promise<ClipboardTextReadResult>;
  close(): Promise<void>;
};

export function createClipboardReader(options: {
  readonly imageReader: ClipboardImageReader;
  readonly textReader: ClipboardTextReader;
}): ClipboardReader {
  return {
    async readClipboard(signal) {
      const image = await options.imageReader.readImage(signal);
      if (image.status === "read") {
        return { status: "image", bytes: image.bytes, platform: image.platform };
      }
      if (image.status === "file_drop" || image.status === "failed") {
        return image;
      }
      const text = await options.textReader.readText(signal);
      if (text.status !== "read") {
        return text;
      }
      const normalized = normalizeClipboardText(text.text);
      return normalized.length === 0
        ? { status: "empty", message: "The clipboard does not contain printable text." }
        : { status: "text", platform: text.platform, text: normalized };
    },
    async close() {
      const outcomes = await Promise.allSettled([
        options.imageReader.close(),
        options.textReader.close(),
      ]);
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      );
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Clipboard readers could not all be closed.");
      }
    },
  };
}

function normalizeClipboardText(text: string): string {
  return text
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .replace(/\t/gu, "    ")
    .split("")
    .filter((character) => character === "\n" || character.charCodeAt(0) >= 0x20)
    .join("");
}
