import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { expect, test, vi } from "vitest";

import type { DeadlineScheduler } from "./exit-policy.js";
import {
  createLinuxClipboardAdapter,
  type LinuxClipboardChild,
  linuxClipboardSpawn,
} from "./linux-clipboard.js";

class FakeClipboardChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly kill = vi.fn((_signal: NodeJS.Signals) => false);
}

function controlledScheduler(): DeadlineScheduler & {
  fire(delayMilliseconds: number): void;
} {
  const deadlines: Array<{
    readonly delayMilliseconds: number;
    readonly onDeadline: () => void;
    cancelled: boolean;
  }> = [];
  return {
    fire(delayMilliseconds) {
      const deadline = deadlines.find(
        (candidate) => candidate.delayMilliseconds === delayMilliseconds && !candidate.cancelled,
      );
      if (deadline === undefined) {
        throw new Error(`No active ${delayMilliseconds}ms deadline exists.`);
      }
      deadline.cancelled = true;
      deadline.onDeadline();
    },
    schedule(delayMilliseconds, onDeadline) {
      const deadline = { delayMilliseconds, onDeadline, cancelled: false };
      deadlines.push(deadline);
      return { cancel: () => (deadline.cancelled = true) };
    },
  };
}

test("the Linux clipboard adapter waits for close before falling back after spawn error", async () => {
  const scheduler = controlledScheduler();
  const children: FakeClipboardChild[] = [];
  const commands: string[] = [];
  const secondSpawned = Promise.withResolvers<FakeClipboardChild>();
  const adapter = createLinuxClipboardAdapter({
    scheduler,
    [linuxClipboardSpawn](command) {
      commands.push(command);
      const child = new FakeClipboardChild();
      children.push(child);
      if (children.length === 2) {
        secondSpawned.resolve(child);
      }
      return child as LinuxClipboardChild;
    },
  });

  const result = adapter.writeText("exact bytes");
  const first = children[0] as FakeClipboardChild;
  first.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }));
  await Promise.resolve();
  expect(commands).toEqual(["wl-copy"]);

  first.emit("close", null);
  const second = await secondSpawned.promise;
  expect(commands).toEqual(["wl-copy", "xclip"]);
  second.emit("close", 0);
  await expect(result).resolves.toBe("copied");
  await expect(adapter.close?.()).resolves.toBeUndefined();
});

test("the Linux clipboard adapter uses single-flight TERM then KILL and still waits for close", async () => {
  const scheduler = controlledScheduler();
  const child = new FakeClipboardChild();
  const adapter = createLinuxClipboardAdapter({
    deadlineMilliseconds: 100,
    reclamationMilliseconds: 20,
    scheduler,
    terminationGraceMilliseconds: 10,
    [linuxClipboardSpawn]() {
      return child as LinuxClipboardChild;
    },
  });

  let settled = false;
  const result = adapter.writeText("bounded bytes").finally(() => {
    settled = true;
  });
  scheduler.fire(100);
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(child.kill).toHaveBeenLastCalledWith("SIGTERM");
  await Promise.resolve();
  expect(settled).toBe(false);

  scheduler.fire(10);
  expect(child.kill).toHaveBeenCalledTimes(2);
  expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
  await Promise.resolve();
  expect(settled).toBe(false);

  child.emit("close", null);
  await expect(result).resolves.toBe("failed");
  await expect(adapter.close?.()).resolves.toBeUndefined();
});
