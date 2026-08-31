import { expect, test } from "vitest";
import { createClipboardReader } from "./clipboard-reader.js";

test("the unified clipboard reader selects a supported image before text", async () => {
  let imageReads = 0;
  let textReads = 0;
  const reader = createClipboardReader({
    imageReader: {
      async close() {},
      async readImage() {
        imageReads += 1;
        return {
          status: "read" as const,
          bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
          platform: "linux_wayland" as const,
        };
      },
    },
    textReader: {
      async close() {},
      async readText() {
        textReads += 1;
        return { status: "read" as const, platform: "linux_wayland" as const, text: "fallback" };
      },
    },
  });

  await expect(reader.readClipboard(new AbortController().signal)).resolves.toEqual({
    status: "image",
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    platform: "linux_wayland",
  });
  expect(imageReads).toBe(1);
  expect(textReads).toBe(0);
  await reader.close();
});

test("the unified clipboard reader falls back to Unicode text only after no image", async () => {
  const reader = createClipboardReader({
    imageReader: {
      async close() {},
      async readImage() {
        return { status: "empty" as const, message: "No image." };
      },
    },
    textReader: {
      async close() {},
      async readText() {
        return { status: "read" as const, platform: "linux_x11" as const, text: "fallback" };
      },
    },
  });

  await expect(reader.readClipboard(new AbortController().signal)).resolves.toEqual({
    status: "text",
    platform: "linux_x11",
    text: "fallback",
  });
  await reader.close();
});

test("the unified clipboard reader keeps FileDrop terminal without reading text", async () => {
  let textReads = 0;
  const reader = createClipboardReader({
    imageReader: {
      async close() {},
      async readImage() {
        return { status: "file_drop" as const, message: "Files are unsupported." };
      },
    },
    textReader: {
      async close() {},
      async readText() {
        textReads += 1;
        return { status: "read" as const, platform: "linux_x11" as const, text: "fallback" };
      },
    },
  });

  await expect(reader.readClipboard(new AbortController().signal)).resolves.toEqual({
    status: "file_drop",
    message: "Files are unsupported.",
  });
  expect(textReads).toBe(0);
  await reader.close();
});

test("the unified clipboard reader normalizes text without admitting terminal controls", async () => {
  const reader = createClipboardReader({
    imageReader: {
      async close() {},
      async readImage() {
        return { status: "empty" as const, message: "No image." };
      },
    },
    textReader: {
      async close() {},
      async readText() {
        return {
          status: "read" as const,
          platform: "wsl_bridge" as const,
          text: "first\r\nsecond\t\u001b[2J",
        };
      },
    },
  });

  await expect(reader.readClipboard(new AbortController().signal)).resolves.toEqual({
    status: "text",
    platform: "wsl_bridge",
    text: "first\nsecond    [2J",
  });
  await reader.close();
});
