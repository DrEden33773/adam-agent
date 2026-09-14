import fs from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { removeTuiFixtureRoot as rm } from "./tui-filesystem.test-support.js";
import { startTuiFixture } from "./tui-fixture.test-support.js";
import { terminalObservationTimeoutMilliseconds } from "./virtual-terminal.test-support.js";

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
    const answerOffset = fixture.output().lastIndexOf("MAIN_SCROLL_119");
    await fixture.waitForCompleteFrameAfter(" · idle", answerOffset);
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

test("PTY resize waits for a current-geometry frame after the PID read completes", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-resize-frame-"));
  const marker = join(root, "terminal-process");
  const program = join(root, "fixture.mjs");
  await writeFile(
    program,
    `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)},String(process.pid));
function frame(text) { process.stdout.write("\\u001b[?2026h\\u001b[2J\\u001b[HMAIN_SCROLL_100\\r\\n"+text+"\\u001b[?2026l"); }
frame("initial");
process.stdin.setEncoding("utf8");
process.stdin.on("data",text=>{if(text.includes("q"))process.exit(0);frame(text.includes("r") ? "resized frame" : "old-size frame");});
process.on("SIGWINCH",()=>{});
`,
  );
  const fixture = startTuiFixture({
    external: true,
    terminalProcessMarker: marker,
    workspaceRoot: root,
    stateRoot: join(root, "state"),
    program: { entrypoint: program, arguments: [], cwd: root },
  });
  const originalRead = fs.promises.readFile;
  const entered = Promise.withResolvers<void>();
  const releaseRead = Promise.withResolvers<void>();
  let resizing: Promise<void> | undefined;
  let captured = false;
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await fixture.waitForScreen("MAIN_SCROLL_100");
    // Delay only this external filesystem read; the real PTY and stty remain in use.
    fs.promises.readFile = (async (...args: Parameters<typeof originalRead>) => {
      const value = await originalRead(...args);
      if (args[0] === marker && !captured) {
        captured = true;
        entered.resolve();
        await releaseRead.promise;
      }
      return value;
    }) as typeof originalRead;
    syncBuiltinESMExports();
    const offset = fixture.output().length;
    resizing = fixture.resize(40, 24);
    void resizing.catch(entered.reject);
    await Promise.race([
      entered.promise,
      new Promise<never>((_, reject) => {
        guard = setTimeout(
          () => reject(new Error("Resize did not reach the PID read")),
          terminalObservationTimeoutMilliseconds,
        );
      }),
    ]);
    if (guard !== undefined) clearTimeout(guard);
    fixture.write("x\n");
    await fixture.waitForCompleteFrameAfter("old-size frame", offset);
    releaseRead.resolve();
    await resizing;
    await fixture.waitForRecordedOutput("old-size frame", offset);
    const frame = fixture.waitForCompleteFrameAfter("MAIN_SCROLL_100", offset);
    fixture.write("r\n");
    await frame;
    expect(fixture.screen()?.join("\n")).toContain("resized frame");
    fixture.write("q\n");
    await fixture.closed;
  } finally {
    if (guard !== undefined) clearTimeout(guard);
    releaseRead.resolve();
    fs.promises.readFile = originalRead;
    syncBuiltinESMExports();
    try {
      await resizing?.catch(() => undefined);
    } finally {
      await fixture.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  }
});
