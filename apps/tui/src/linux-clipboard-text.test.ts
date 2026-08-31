import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";
import {
  createLinuxClipboardTextReader,
  type LinuxClipboardTextChild,
  linuxClipboardTextSpawn,
} from "./linux-clipboard-text.js";

class FakeTextChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly kill = vi.fn((_signal: NodeJS.Signals) => false);
}

test("the WSL clipboard text reader owns STA and exact UTF-8 output", async () => {
  const child = new FakeTextChild();
  const calls: Array<{ readonly command: string; readonly arguments_: readonly string[] }> = [];
  const reader = createLinuxClipboardTextReader({
    environment: { WSL_DISTRO_NAME: "Ubuntu" },
    [linuxClipboardTextSpawn](command, arguments_) {
      calls.push({ command, arguments_ });
      return child as LinuxClipboardTextChild;
    },
  });

  const result = reader.readText(new AbortController().signal);
  child.stdout.end(Buffer.from("剪贴板 e\u0301", "utf8"));
  child.emit("close", 0);
  await expect(result).resolves.toEqual({
    status: "read",
    platform: "wsl_bridge",
    text: "剪贴板 é",
  });
  expect(calls[0]?.command).toBe("powershell.exe");
  expect(calls[0]?.arguments_.slice(0, 4)).toEqual([
    "-NoProfile",
    "-NonInteractive",
    "-STA",
    "-Command",
  ]);
  await reader.close();
});

test.each([
  {
    name: "Wayland",
    environment: { WAYLAND_DISPLAY: "wayland-0" },
    command: "wl-paste",
    arguments_: ["--no-newline", "--type", "text/plain;charset=utf-8"],
    platform: "linux_wayland",
  },
  {
    name: "X11",
    environment: { DISPLAY: ":1" },
    command: "xclip",
    arguments_: ["-selection", "clipboard", "-t", "UTF8_STRING", "-o"],
    platform: "linux_x11",
  },
])("the $name clipboard text reader owns exact UTF-8 output", async (fixture) => {
  const child = new FakeTextChild();
  const calls: Array<{ readonly command: string; readonly arguments_: readonly string[] }> = [];
  const reader = createLinuxClipboardTextReader({
    environment: fixture.environment,
    [linuxClipboardTextSpawn](command, arguments_) {
      calls.push({ command, arguments_ });
      return child as LinuxClipboardTextChild;
    },
  });

  const result = reader.readText(new AbortController().signal);
  child.stdout.end(Buffer.from("plain text", "utf8"));
  child.emit("close", 0);
  await expect(result).resolves.toEqual({
    status: "read",
    platform: fixture.platform,
    text: "plain text",
  });
  expect(calls).toEqual([{ command: fixture.command, arguments_: fixture.arguments_ }]);
  await reader.close();
});

test("aborting one clipboard text read terminates and joins its exact helper", async () => {
  const child = new FakeTextChild();
  const controller = new AbortController();
  const reader = createLinuxClipboardTextReader({
    environment: { WSL_DISTRO_NAME: "Ubuntu" },
    [linuxClipboardTextSpawn]() {
      return child as LinuxClipboardTextChild;
    },
  });

  const result = reader.readText(controller.signal);
  controller.abort();
  expect(child.kill).toHaveBeenLastCalledWith("SIGTERM");
  child.emit("close", null);
  await expect(result).resolves.toEqual({
    status: "failed",
    message: "Clipboard acquisition cancelled.",
  });
  await reader.close();
});

test("the clipboard text reader fails closed on invalid UTF-8", async () => {
  const child = new FakeTextChild();
  const reader = createLinuxClipboardTextReader({
    environment: { DISPLAY: ":1" },
    [linuxClipboardTextSpawn]() {
      return child as LinuxClipboardTextChild;
    },
  });

  const result = reader.readText(new AbortController().signal);
  child.stdout.end(Buffer.from([0xc3, 0x28]));
  child.emit("close", 0);
  await expect(result).resolves.toEqual({
    status: "failed",
    message: "Clipboard text is not valid UTF-8.",
  });
  await reader.close();
});
