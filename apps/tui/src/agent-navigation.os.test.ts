import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { removeTuiFixtureRoot, waitForFileContents } from "./tui-filesystem.test-support.js";
import { cleanupActiveTuiFixtures, startTuiFixture } from "./tui-fixture.test-support.js";

afterEach(cleanupActiveTuiFixtures);

test("managed viewer wheel owns a fresh frame and leaves the Main viewport unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-agent-navigation-wheel-"));
  const workspaceRoot = join(root, "workspace");
  const controlRoot = join(root, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  try {
    const fixture = startTuiFixture({
      controlRoot,
      scenario: "managed-live-scroll",
      stateRoot: join(root, "state"),
      workspaceRoot,
    });
    await fixture.waitForScreen("Adam · New session");
    fixture.write(
      `${Array.from({ length: 160 }, (_, index) => `Main-evidence-${index}`).join(" ")}\r`,
    );
    await waitForFileContents(join(controlRoot, "managed-live-ready"), "ready\n");
    await waitForFileContents(join(controlRoot, "managed-active-parent-waiting"), "waiting\n");
    fixture.write("/agents\r");
    await fixture.waitForScreen("type search");
    fixture.write("\r");
    await fixture.waitForScreen("live-7");
    const beforeWheel = fixture.output().length;
    fixture.write("\u001b[<64;40;12M");
    await fixture.waitForCompleteFrameAfter("reading paused", beforeWheel);
    const paused = fixture.screen()?.join("\n") ?? "";
    expect(paused).toContain("Agent detail");
    expect(paused).not.toContain("live-7");
    const beforeBottom = fixture.output().length;
    fixture.write("\u001b[<65;40;12M");
    await fixture.waitForCompleteFrameAfter("following live tail", beforeBottom);
    expect(fixture.screen()?.join("\n")).toContain("live-7");
    fixture.write("\u001b[27;1;27~");
    await fixture.waitForScreen("type search");
    const beforeMain = fixture.output().length;
    fixture.write("\u001b[27;1;27~");
    await fixture.waitForCompleteFrameAfter("fake.local", beforeMain, "type search");
    const beforeEvidence = fixture.output().length;
    fixture.write("\u001b[<64;40;12M".repeat(6));
    await fixture.waitForCompleteFrameAfter("Main-evidence-", beforeEvidence);
    const main = fixture.screen();
    const beforeMainWheel = fixture.output().length;
    fixture.write("\u001b[<64;40;12M");
    await fixture.waitForCompleteFrameAfter("fake.local", beforeMainWheel);
    const scrolledMain = fixture.screen();
    expect(scrolledMain?.filter((line) => line.includes("Main-evidence-"))).not.toEqual(
      main?.filter((line) => line.includes("Main-evidence-")),
    );
    expect(scrolledMain?.join("\n")).toContain("Main-evidence-");
    const beforeRestoreMain = fixture.output().length;
    fixture.write("\u001b[<65;40;12M");
    await fixture.waitForCompleteFrameAfter("fake.local", beforeRestoreMain);
    expect(fixture.screen()).toEqual(main);
    fixture.write("/agents\r");
    await fixture.waitForScreen("type search");
    fixture.write("\r");
    await fixture.waitForScreen("live-7");
    const beforeSecondWheel = fixture.output().length;
    fixture.write("\u001b[<64;40;12M");
    await fixture.waitForCompleteFrameAfter("reading paused", beforeSecondWheel);
    fixture.write("\u001b[27;1;27~");
    await fixture.waitForScreen("type search");
    const beforeReturn = fixture.output().length;
    fixture.write("\u001b[27;1;27~");
    await fixture.waitForCompleteFrameAfter("fake.local", beforeReturn, "type search");
    expect(fixture.screen()).toEqual(main);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await cleanupActiveTuiFixtures();
    await removeTuiFixtureRoot(root, { recursive: true, force: true });
  }
});
