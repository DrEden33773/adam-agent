import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { removeTuiFixtureRoot, waitForFileContents } from "./tui-filesystem.test-support.js";
import { cleanupActiveTuiFixtures, startTuiFixture } from "./tui-fixture.test-support.js";

afterEach(cleanupActiveTuiFixtures);

test("production child viewer wheel preserves manual tail control and the independent Main viewport", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-agent-navigation-wheel-"));
  const workspaceRoot = join(root, "workspace");
  const controlRoot = join(root, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  await writeFile(join(workspaceRoot, "evidence.txt"), "Current child evidence.\n");
  try {
    const fixture = startTuiFixture({
      controlRoot,
      scenario: "managed-control",
      stateRoot: join(root, "state"),
      workspaceRoot,
    });
    const press = async (keys: string, expected: string, absentText?: string) => {
      const offset = fixture.output().length;
      fixture.write(keys);
      await fixture.waitForCompleteFrameAfter(expected, offset, absentText);
    };
    const openViewer = async () => {
      await press("\u001b[B", "● Main");
      await press("\u001b[B", "● @explore-1");
      await press("\r", "Child-live-49");
    };
    const closeViewer = async () => {
      await press("\u001b[27;1;27~", "Fleet", "Conversation ·");
      await press("\u001b[27;1;27~", "Fleet", "● @explore-1");
    };
    const mainViewport = () => fixture.screen()?.filter((line) => line.includes("Main-evidence-"));
    await fixture.waitForScreen("Adam · New session");
    await press(
      `${Array.from({ length: 160 }, (_, index) => `Main-evidence-${index}`).join(" ")}\r`,
      "Confirm delegation",
    );
    await press("\r", "MAIN_READY");
    await waitForFileContents(join(controlRoot, "child-started"), "started\n");
    await fixture.waitForScreen(" · idle");
    await openViewer();
    await press("\u001b[<64;40;12M", "Manual scroll");
    const paused = fixture.screen()?.join("\n") ?? "";
    expect(paused).toContain("Conversation · @explore-1");
    expect(paused).not.toContain("Child-live-49");
    await press("\u001b[<65;40;12M", "Following tail");
    expect(fixture.screen()?.join("\n")).toContain("Child-live-49");
    await closeViewer();
    await press("\u001b[<64;40;12M".repeat(6), "Main-evidence-");
    const main = mainViewport();
    expect(main?.length).toBeGreaterThan(0);
    await press("\u001b[<64;40;12M", "fake.local");
    expect(mainViewport()).not.toEqual(main);
    expect(mainViewport()?.length).toBeGreaterThan(0);
    await press("\u001b[<65;40;12M", "fake.local");
    expect(mainViewport()).toEqual(main);
    await openViewer();
    await press("\u001b[<64;40;12M", "Manual scroll");
    await closeViewer();
    expect(mainViewport()).toEqual(main);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await cleanupActiveTuiFixtures();
    await removeTuiFixtureRoot(root, { recursive: true, force: true });
  }
});
