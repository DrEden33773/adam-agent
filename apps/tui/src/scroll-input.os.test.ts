import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { removeTuiFixtureRoot as rm } from "./tui-filesystem.test-support.js";
import { startTuiFixture } from "./tui-fixture.test-support.js";

test("PTY Main viewport scroll preserves drafts and resize anchors and restores terminal modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-main-scroll-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  const fixture = startTuiFixture({
    terminalProcessMarker: join(root, "terminal-process"),
    external: true,
    scenario: "scroll-viewport",
    noColor: true,
    workspaceRoot,
    stateRoot: join(root, "state"),
  });
  const marker = (index: number) => `MAIN_SCROLL_${String(index).padStart(3, "0")}`;
  const firstRow = () => {
    const match = fixture
      .screen()
      ?.join("\n")
      .match(/MAIN_SCROLL_(\d+)/u);
    expect(match).not.toBeNull();
    return Number(match?.[1]);
  };
  const move = async (input: string, delta: number) => {
    const before = firstRow();
    const offset = fixture.output().length;
    fixture.write(input);
    await fixture.waitForCompleteFrameAfter(
      marker(before + delta),
      offset,
      delta > 0 ? marker(before) : undefined,
    );
    expect(firstRow()).toBe(before + delta);
    expect(fixture.screen()?.join("\n")).toContain("retained draft");
  };
  try {
    await fixture.waitForScreen("Adam · New session");
    fixture.write("Show Main rows");
    await fixture.waitForScreen("Show Main rows");
    fixture.write("\r");
    await fixture.waitForScreen("MAIN_SCROLL_119");
    await fixture.waitForScreen("Adam · Streaming session");
    const draftOffset = fixture.output().length;
    fixture.write("retained draft");
    await fixture.waitForCompleteFrameAfter("retained draft", draftOffset);
    // At 80x24 the Main viewport is thirteen rows, with four rows of page overlap.
    await move("\u001b[5~", -9);
    await move("\u001b[6~", 9);
    await move("\u001b[<64;8;8M", -1);
    await move("\u001b[<65;8;8M", 1);
    await move("\u001b[5~", -9);
    const anchor = firstRow();
    for (const columns of [40, 80, 120]) {
      const offset = fixture.output().length;
      await fixture.resize(columns, 24);
      await fixture.waitForCompleteFrameAfter(marker(anchor), offset);
      expect(firstRow()).toBe(anchor);
      expect(fixture.screen()?.join("\n")).toContain("retained draft");
      expect(fixture.screen()?.every((line) => visibleWidth(line) <= columns)).toBe(true);
    }
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    for (const mode of ["1049", "1000", "1006", "2004"]) {
      expect(result.stdout).toContain(`\u001b[?${mode}h`);
      expect(result.stdout).toContain(`\u001b[?${mode}l`);
      expect(result.stdout.indexOf(`\u001b[?${mode}h`)).toBeLessThan(
        result.stdout.lastIndexOf(`\u001b[?${mode}l`),
      );
    }
  } finally {
    await fixture.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
