import {
  type ArtifactReference,
  presentationArtifactPageMaximumBytes,
} from "@adam-agent/presentation";
import { expect, test } from "vitest";
import { LargeReasoningViewStore, largeReasoningViewPolicy } from "./large-reasoning-view.js";

test("oversized reasoning evicts offscreen ranges by bytes and reloads them on upward traversal", async () => {
  const artifact: ArtifactReference = {
    byteCount: largeReasoningViewPolicy.thresholdBytes + 1,
    id: `sha256:${"a".repeat(64)}`,
    mediaType: "text/plain; charset=utf-8",
    source: "model_response",
  };
  const readOffsets: number[] = [];
  const changeWaiters: Array<() => void> = [];
  const store = new LargeReasoningViewStore({
    cacheBytes: 2 * presentationArtifactPageMaximumBytes,
    onChange() {
      changeWaiters.shift()?.();
    },
    async readArtifact(command) {
      const offset = command.range?.offset ?? 0;
      const byteCount = Math.min(presentationArtifactPageMaximumBytes, artifact.byteCount - offset);
      const nextOffset = offset + byteCount;
      readOffsets.push(offset);
      return {
        status: "admitted",
        commandId: `read-${readOffsets.length}`,
        resource: {
          byteCount,
          eof: nextOffset === artifact.byteCount,
          mediaType: artifact.mediaType,
          nextRange:
            nextOffset === artifact.byteCount
              ? null
              : { offset: nextOffset, maximumBytes: presentationArtifactPageMaximumBytes },
          offset,
          text: String.fromCodePoint(65 + readOffsets.length).repeat(byteCount),
          totalByteCount: artifact.byteCount,
        },
      };
    },
  });
  const input = { artifact, id: "reasoning-1", preferEnd: false, text: null } as const;
  const changeAfter = async (action: () => void): Promise<void> => {
    const changed = Promise.withResolvers<void>();
    changeWaiters.push(changed.resolve);
    action();
    await changed.promise;
  };

  await changeAfter(() => store.sync(input));
  await changeAfter(() => store.navigate(input.id, "down"));
  await changeAfter(() => store.navigate(input.id, "down"));
  await changeAfter(() => store.navigate(input.id, "down"));
  expect(readOffsets).toEqual([0, 16_384, 32_768, 49_152]);

  await changeAfter(() => store.navigate(input.id, "up"));
  expect(readOffsets).toEqual([0, 16_384, 32_768, 49_152]);
  expect(store.sync(input)?.pages.some((page) => page.offset === 32_768)).toBe(true);

  await changeAfter(() => store.navigate(input.id, "up"));
  await changeAfter(() => store.navigate(input.id, "up"));
  expect(readOffsets).toEqual([0, 16_384, 32_768, 49_152, 16_384, 0]);
  expect(store.sync(input)?.pages.some((page) => page.offset === 0)).toBe(true);
});
