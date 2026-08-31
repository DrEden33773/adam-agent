import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { expect, test, vi } from "vitest";

import type { DeadlineScheduler } from "./exit-policy.js";
import {
  createLinuxClipboardImageReader,
  type LinuxClipboardImageChild,
  linuxClipboardImageSpawn,
} from "./linux-clipboard-image.js";

class FakeImageChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly kill = vi.fn((_signal: NodeJS.Signals) => false);
}

function controlledScheduler(): DeadlineScheduler & { fire(milliseconds: number): void } {
  const deadlines: Array<{
    readonly milliseconds: number;
    readonly callback: () => void;
    cancelled: boolean;
  }> = [];
  return {
    fire(milliseconds) {
      const deadline = deadlines.find(
        (candidate) => candidate.milliseconds === milliseconds && !candidate.cancelled,
      );
      if (deadline === undefined) {
        throw new Error(`No active ${milliseconds}ms deadline exists.`);
      }
      deadline.cancelled = true;
      deadline.callback();
    },
    schedule(milliseconds, callback) {
      const deadline = { milliseconds, callback, cancelled: false };
      deadlines.push(deadline);
      return { cancel: () => (deadline.cancelled = true) };
    },
  };
}

test.each([
  {
    name: "Wayland",
    environment: { WAYLAND_DISPLAY: "wayland-0" },
    command: "wl-paste",
    arguments_: ["--no-newline", "--type", "image/png"],
    platform: "linux_wayland",
  },
  {
    name: "X11",
    environment: { DISPLAY: ":1" },
    command: "xclip",
    arguments_: ["-selection", "clipboard", "-t", "image/png", "-o"],
    platform: "linux_x11",
  },
  {
    name: "WSL",
    environment: { WSL_DISTRO_NAME: "Ubuntu" },
    command: "powershell.exe",
    arguments_: ["-NoProfile", "-NonInteractive", "-Command"],
    platform: "wsl_bridge",
  },
])(
  "the Linux clipboard image reader owns the $name command and exact output bytes",
  async (fixture) => {
    const child = new FakeImageChild();
    const calls: Array<{ readonly command: string; readonly arguments_: readonly string[] }> = [];
    const reader = createLinuxClipboardImageReader({
      environment: fixture.environment,
      [linuxClipboardImageSpawn](command, arguments_) {
        calls.push({ command, arguments_ });
        return child as LinuxClipboardImageChild;
      },
    });

    const result = reader.readImage();
    child.stdout.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    child.emit("close", 0);
    await expect(result).resolves.toEqual({
      status: "read",
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      platform: fixture.platform,
    });
    expect(calls[0]?.command).toBe(fixture.command);
    expect(calls[0]?.arguments_.slice(0, fixture.arguments_.length)).toEqual(fixture.arguments_);
    await expect(reader.close()).resolves.toBeUndefined();
  },
);

test("the Linux clipboard image reader distinguishes empty and unsupported clipboard results", async () => {
  const children: FakeImageChild[] = [];
  const reader = createLinuxClipboardImageReader({
    environment: { WAYLAND_DISPLAY: "wayland-0" },
    [linuxClipboardImageSpawn]() {
      const child = new FakeImageChild();
      children.push(child);
      return child as LinuxClipboardImageChild;
    },
  });

  const result = reader.readImage();
  children[0]?.emit("close", 0);
  await Promise.resolve();
  children[1]?.emit("close", 2);
  await expect(result).resolves.toEqual({
    status: "empty",
    message: "The clipboard does not contain image bytes.",
  });
  await reader.close();
});

test("the Linux clipboard image reader falls back from PNG to exact JPEG bytes", async () => {
  const children: FakeImageChild[] = [];
  const calls: string[][] = [];
  const reader = createLinuxClipboardImageReader({
    environment: { DISPLAY: ":1" },
    [linuxClipboardImageSpawn](_command, arguments_) {
      const child = new FakeImageChild();
      children.push(child);
      calls.push([...arguments_]);
      return child as LinuxClipboardImageChild;
    },
  });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

  const result = reader.readImage();
  children[0]?.emit("close", 2);
  await Promise.resolve();
  children[1]?.stdout.end(jpeg);
  children[1]?.emit("close", 0);

  await expect(result).resolves.toEqual({
    status: "read",
    bytes: jpeg,
    platform: "linux_x11",
  });
  expect(calls).toEqual([
    ["-selection", "clipboard", "-t", "image/png", "-o"],
    ["-selection", "clipboard", "-t", "image/jpeg", "-o"],
  ]);
  await reader.close();
});

test("the Linux clipboard image reader terminates and joins a helper after its deadline", async () => {
  const scheduler = controlledScheduler();
  const child = new FakeImageChild();
  const reader = createLinuxClipboardImageReader({
    deadlineMilliseconds: 100,
    environment: { DISPLAY: ":1" },
    reclamationMilliseconds: 20,
    scheduler,
    terminationGraceMilliseconds: 10,
    [linuxClipboardImageSpawn]() {
      return child as LinuxClipboardImageChild;
    },
  });

  const result = reader.readImage();
  scheduler.fire(100);
  expect(child.kill).toHaveBeenLastCalledWith("SIGTERM");
  scheduler.fire(10);
  expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
  child.emit("close", null);
  await expect(result).resolves.toEqual({
    status: "failed",
    message: "Clipboard image acquisition reached its deadline.",
  });
  await expect(reader.close()).resolves.toBeUndefined();
});
