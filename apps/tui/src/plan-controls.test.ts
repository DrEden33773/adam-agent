import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, test } from "vitest";
import { readFilesRecursively, removeTuiFixtureRoot as rm } from "./tui-filesystem.test-support.js";
import {
  cleanupActiveTuiFixtures,
  latestSynchronizedFrame,
  startTuiFixture as startFixture,
} from "./tui-fixture.test-support.js";

afterEach(async () => {
  await cleanupActiveTuiFixtures();
});

test("current hybrid Plan copy is policy-aware in notices and footer", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-plan-hybrid-copy-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      launch: {},
      scenario: "skill-selection",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitForScreen("Select an exact model target");
    fixture.write("\r");
    await fixture.waitForScreen("Adam · New session");
    fixture.write("Admit the current hybrid Plan session\r");
    await fixture.waitForScreen("Skill selection complete.");
    const afterAnswer = fixture.output().lastIndexOf("Skill selection complete.");
    await fixture.waitForCompleteFrameAfter(" · idle", afterAnswer);
    const beforePlan = fixture.output().length;
    fixture.write("/plan\r");
    await fixture.waitForCompleteFrameAfter("Plan exploring", beforePlan);
    const output = fixture.output().slice(beforePlan);
    const frame = fixture.screen()?.join("\n") ?? "";

    expect(output).toContain("Entered Plan.");
    expect(frame).toContain("Plan exploring");
    expect(frame).toContain("plan-policy.hybrid-todo-v1 · inspect auto · exec asks · files deny");
    expect(`${output}\n${frame}`).not.toContain("read-only Plan");
    expect(frame).not.toContain("Plan exploring · read-only");

    for (const [columns, rows, policyCopy] of [
      [120, 40, ["plan-policy.hybrid-todo-v1 · inspect auto · exec asks · files deny"]],
      [80, 24, ["plan-policy.hybrid-todo-v1 · inspect auto · exec asks · files deny"]],
      [40, 12, ["inspect:auto · exec:ask ·", "files:deny", "Todo:session"]],
    ] as const) {
      await fixture.resize(columns, rows);
      const resizedFrame = fixture.screen() ?? [];
      for (const expected of policyCopy) {
        expect(resizedFrame.join("\n")).toContain(expected);
      }
      expect(resizedFrame.join("\n")).not.toContain("read-only");
      expect(resizedFrame.every((line) => visibleWidth(line) <= columns)).toBe(true);
    }

    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("production Help renders policy-neutral Plan Registry copy", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-plan-help-copy-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ stateRoot, workspaceRoot });
    await fixture.waitForScreen("Adam · New session");
    await fixture.resize(120, 40);
    const beforeHelp = fixture.output().length;
    fixture.write("/help commands\r");
    await fixture.waitForCompleteFrameAfter("Command Reference", beforeHelp);
    const frame = fixture.screen()?.join("\n") ?? "";
    expect(frame).toContain("/plan · idle only · Enter or exit the authoritative Plan cycle.");
    expect(frame).not.toContain("read-only Plan");

    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("NO_COLOR preserves current hybrid Plan policy copy without claiming read-only", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-plan-hybrid-no-color-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      launch: {},
      noColor: true,
      scenario: "skill-selection",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitForScreen("Select an exact model target");
    fixture.write("\r");
    await fixture.waitForScreen("Adam · New session");
    fixture.write("Admit the colorless hybrid Plan session\r");
    await fixture.waitForScreen("Skill selection complete.");
    const afterAnswer = fixture.output().lastIndexOf("Skill selection complete.");
    await fixture.waitForCompleteFrameAfter(" · idle", afterAnswer);
    const beforePlan = fixture.output().length;
    fixture.write("/plan\r");
    await fixture.waitForCompleteFrameAfter(
      "plan-policy.hybrid-todo-v1 · inspect auto · exec asks · files deny",
      beforePlan,
    );
    const frame = fixture.screen()?.join("\n") ?? "";

    expect(frame).toContain("Entered Plan.");
    expect(frame).not.toContain("read-only");
    expect(frame).not.toContain("\u001b[38;2;");
    expect(frame).not.toContain("\u001b[48;2;");

    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("historical read-v1 Plan keeps exact read-only footer wording", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-plan-read-v1-copy-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "plan-read-v1", stateRoot, workspaceRoot });
    await fixture.waitForCompleteFrameAfter("plan-policy.read-v1 · read-only", 0);
    let frame = fixture.screen() ?? [];
    expect(frame.join("\n")).toContain("Plan exploring");
    expect(frame.join("\n")).not.toContain("hybrid-v1");

    await fixture.resize(40, 12);
    frame = fixture.screen() ?? [];
    expect(frame.join("\n")).toContain("plan read-only");
    expect(frame.every((line) => visibleWidth(line) <= 40)).toBe(true);

    const beforeExit = fixture.output().length;
    fixture.write("/plan\r");
    await fixture.waitForCompleteFrameAfter("Exited Plan.", beforeExit);
    expect(fixture.screen()?.join("\n") ?? "").not.toContain("plan read-only");

    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a new-session draft toggles policy-aware Plan without creating durable identity", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-plan-status-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ launch: {}, stateRoot, workspaceRoot });
    await fixture.waitForScreen("Select an exact model target");
    const beforeTarget = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForCompleteFrameAfter("Adam · New session", beforeTarget);
    const beforeTargetClose = fixture.output().length;
    await fixture.waitForCompleteFrameAfter("New session draft · idle", beforeTargetClose);
    await fixture.resize(120, 40);

    const beforeEntry = fixture.output().length;
    fixture.write("/plan\r");
    await fixture.waitForCompleteFrameAfter("Plan exploring", beforeEntry);
    let frame = latestSynchronizedFrame(fixture.output()).join("\n");
    expect(frame).toContain("Plan exploring");
    expect(frame).not.toContain("read-only");
    expect(frame).not.toContain("plan-policy.");
    expect(await readFilesRecursively(stateRoot)).not.toContain('"type":"session_genesis"');

    const beforeTargetSwitch = fixture.output().length;
    fixture.write("/target\r");
    await fixture.waitForCompleteFrameAfter("Select an exact model target", beforeTargetSwitch);
    const beforeTargetSelection = fixture.output().length;
    fixture.write("\u001b[B\r");
    await fixture.waitForCompleteFrameAfter(
      "deepseek-v4-pro.direct · Certified",
      beforeTargetSelection,
    );
    const beforeSwitchedTargetClose = fixture.output().length;
    await fixture.waitForCompleteFrameAfter("Plan exploring", beforeSwitchedTargetClose);
    expect(fixture.screen()?.join("\n") ?? "").not.toContain("read-only");
    expect(fixture.screen()?.join("\n") ?? "").not.toContain("plan-policy.");

    const beforeExit = fixture.output().length;
    fixture.write("/plan\r");
    await fixture.waitForRecordedOutput("Exited Plan.", beforeExit);
    frame = latestSynchronizedFrame(fixture.output().slice(beforeExit)).join("\n");
    expect(frame).not.toContain("Plan exploring");

    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a prompt-admitted production session enters policy-aware Plan after its first turn", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-plan-after-admission-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      launch: {},
      scenario: "skill-selection",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitForScreen("Select an exact model target");
    const beforeTarget = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForCompleteFrameAfter("Adam · New session", beforeTarget);
    const beforeTargetClose = fixture.output().length;
    await fixture.waitForCompleteFrameAfter("New session draft · idle", beforeTargetClose);

    const beforePrompt = fixture.output().length;
    fixture.write("Confirm the current Plan capability\r");
    await fixture.waitForRecordedOutput("Skill selection complete.", beforePrompt);
    const afterAnswer = fixture.output().lastIndexOf("Skill selection complete.");
    await fixture.waitForCompleteFrameAfter(" · idle", afterAnswer);

    const beforePlan = fixture.output().length;
    fixture.write("/plan\r");
    await fixture.waitForCompleteFrameAfter(
      "plan-policy.hybrid-todo-v1 · inspect auto · exec asks · files deny",
      beforePlan,
    );
    const frame = latestSynchronizedFrame(fixture.output().slice(beforePlan)).join("\n");
    expect(frame).toContain("Plan exploring");
    expect(frame).not.toContain("read-only");
    expect(frame).not.toContain("Plan could not be entered from the current session state.");

    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI reviews, revises, and implements the exact ready Plan", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-plan-review-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ launch: {}, scenario: "plan-review", stateRoot, workspaceRoot });
    await fixture.waitForScreen("Select an exact model target");
    const beforeTarget = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForCompleteFrameAfter("Adam · New session", beforeTarget);
    const beforeTargetClose = fixture.output().length;
    await fixture.waitForCompleteFrameAfter("New session draft · idle", beforeTargetClose);
    await fixture.resize(120, 40);
    const beforeEntry = fixture.output().length;
    fixture.write("/plan\r");
    await fixture.waitForCompleteFrameAfter("Plan exploring", beforeEntry);

    const beforeInitialSubmission = fixture.output().length;
    fixture.write("Create the exact implementation plan\r");
    await fixture.waitForCompleteFrameAfter("Review exact submitted plan", beforeInitialSubmission);
    let frame = latestSynchronizedFrame(fixture.output().slice(beforeInitialSubmission)).join("\n");
    expect(frame).toContain("Fixture plan 1");
    expect(frame).toContain("# Fixture plan 1");
    expect(frame).toContain("Implement the exact reviewed change.");
    expect(frame).toContain("sha256:");
    expect(frame).toContain("Approve and implement");
    expect(frame).toContain("Request changes…");
    expect(frame).toContain("Cancel plan");

    fixture.write("\u001b[B");
    fixture.write("\r");
    await fixture.waitForCompleteFrameAfter(
      "Revision intent active; submit the main composer when ready.",
      beforeInitialSubmission,
    );

    const beforeRevisionSubmit = fixture.output().length;
    fixture.write("Preserve this revision request\r");
    await fixture.waitForCompleteFrameAfter("Review exact submitted plan", beforeRevisionSubmit);
    frame = latestSynchronizedFrame(fixture.output()).join("\n");
    expect(frame).toContain("Review exact submitted plan");
    expect(frame).toContain("# Fixture plan 2");
    const beforeApproval = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForCompleteFrameAfter(
      "Approved Plan implementation complete.",
      beforeApproval,
    );
    await fixture.waitForCompleteFrameAfter(
      "Approved Plan implementation completed.",
      beforeApproval,
    );
    const beforeArtifacts = fixture.output().length;
    fixture.write("/artifacts \r");
    await fixture.waitForCompleteFrameAfter("Session artifacts", beforeArtifacts);
    frame = latestSynchronizedFrame(fixture.output().slice(beforeArtifacts)).join("\n");
    expect(frame).toContain("Fixture plan 2");
    expect(frame).toContain("approved");
    const beforeArtifactSelection = fixture.output().length;
    fixture.write("\u001b[B");
    await fixture.waitForCompleteFrameAfter("Fixture plan 2", beforeArtifactSelection);
    const beforeArtifactDetail = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForCompleteFrameAfter("Artifact detail", beforeArtifactDetail);
    frame = latestSynchronizedFrame(fixture.output().slice(beforeArtifactDetail)).join("\n");
    expect(frame).toContain("# Fixture plan 2");
    expect(frame).toContain("Implement the exact reviewed change.");

    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the minimum supported Plan review never hides executable approval actions", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-plan-review-minimum-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ launch: {}, scenario: "plan-review", stateRoot, workspaceRoot });
    await fixture.waitForScreen("Select an exact model target");
    fixture.write("\r");
    await fixture.waitForScreen("Adam · New session");
    await fixture.waitForScreen("New session draft · idle");
    fixture.write("/plan\r");
    await fixture.waitForScreen("Plan exploring");
    await fixture.resize(40, 12);

    const beforeSubmission = fixture.output().length;
    fixture.write("Create a safely visible implementation plan\r");
    await fixture.waitForCompleteFrameAfter("Review exact submitted plan", beforeSubmission);
    const frame = latestSynchronizedFrame(fixture.output().slice(beforeSubmission)).join("\n");
    expect(frame).toContain("Approve and implement");
    expect(frame).toContain("Request changes…");
    expect(frame).toContain("Cancel plan");
    expect(frame).toContain("Enter choose");

    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI keeps the exact composer draft while a ready Plan review is dismissed", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-plan-draft-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ launch: {}, scenario: "plan-review", stateRoot, workspaceRoot });
    await fixture.waitForScreen("Select an exact model target");
    const beforeTarget = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForCompleteFrameAfter("Adam · New session", beforeTarget);
    const beforeTargetClose = fixture.output().length;
    await fixture.waitForCompleteFrameAfter("New session draft · idle", beforeTargetClose);
    await fixture.resize(120, 40);
    const beforeEntry = fixture.output().length;
    fixture.write("/plan\r");
    await fixture.waitForCompleteFrameAfter("Plan exploring", beforeEntry);
    const beforePlan = fixture.output().length;
    fixture.write("Create a plan whose ready state must remain exact\r");
    await fixture.waitForCompleteFrameAfter("Review exact submitted plan", beforePlan);

    const beforeFirstDismiss = fixture.output().length;
    fixture.write("\u001b");
    await fixture.waitForCompleteFrameAfter("Plan ready r2 · review required", beforeFirstDismiss);
    const beforeReopen = fixture.output().length;
    fixture.write("Preserve this exact revision draft\r");
    await fixture.waitForCompleteFrameAfter("Review exact submitted plan", beforeReopen);
    const beforeDismiss = fixture.output().length;
    fixture.write("\u001b");
    await fixture.waitForCompleteFrameAfter("Plan ready r2 · review required", beforeDismiss);
    const screen = fixture.screen()?.join("\n") ?? "";
    expect(screen).toContain("Preserve this exact revision draft");
    expect(screen).toContain("Plan ready r2 · review required");

    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI cancels a ready Plan only after concise confirmation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-plan-cancel-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ launch: {}, scenario: "plan-review", stateRoot, workspaceRoot });
    await fixture.waitForScreen("Select an exact model target");
    const beforeTarget = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForCompleteFrameAfter("Adam · New session", beforeTarget);
    const beforeTargetClose = fixture.output().length;
    await fixture.waitForCompleteFrameAfter("New session draft · idle", beforeTargetClose);
    await fixture.resize(120, 40);
    const beforeEntry = fixture.output().length;
    fixture.write("/plan\r");
    await fixture.waitForCompleteFrameAfter("Plan exploring", beforeEntry);
    const beforePlan = fixture.output().length;
    fixture.write("Create a plan that will be cancelled exactly\r");
    await fixture.waitForCompleteFrameAfter("Review exact submitted plan", beforePlan);

    const openCancellation = async (): Promise<void> => {
      let beforeSelection = fixture.output().length;
      fixture.write("\u001b[B");
      await fixture.waitForCompleteFrameAfter("Request changes…", beforeSelection);
      beforeSelection = fixture.output().length;
      fixture.write("\u001b[B");
      await fixture.waitForCompleteFrameAfter("Cancel plan", beforeSelection);
      const beforeConfirmation = fixture.output().length;
      fixture.write("\r");
      await fixture.waitForCompleteFrameAfter("Cancel this exact plan?", beforeConfirmation);
    };

    await openCancellation();
    const beforeSafeDefault = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForCompleteFrameAfter("Review exact submitted plan", beforeSafeDefault);
    expect(fixture.screen()?.join("\n") ?? "").toContain("Plan ready r2 · review required");

    await openCancellation();
    const beforeConfirmSelection = fixture.output().length;
    fixture.write("\u001b[B");
    await fixture.waitForCompleteFrameAfter("Confirm cancellation", beforeConfirmSelection);
    const beforeCancellation = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForCompleteFrameAfter("Plan cancelled.", beforeCancellation);
    const screen = fixture.screen()?.join("\n") ?? "";
    expect(screen).toContain("Plan cancelled.");
    expect(screen).not.toContain("Plan ready");

    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI explicitly continues a recovered unstarted Plan approval", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-plan-recovery-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      launch: {},
      scenario: "plan-review-recovery",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitForScreen("Select an exact model target");
    const beforeTarget = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForCompleteFrameAfter("Adam · New session", beforeTarget);
    const beforeTargetClose = fixture.output().length;
    await fixture.waitForCompleteFrameAfter("New session draft · idle", beforeTargetClose);
    await fixture.resize(120, 40);
    const beforeEntry = fixture.output().length;
    fixture.write("/plan\r");
    await fixture.waitForCompleteFrameAfter("Plan exploring", beforeEntry);
    const beforePlan = fixture.output().length;
    fixture.write("Create a plan whose durable approval must be recovered\r");
    await fixture.waitForCompleteFrameAfter("Review exact submitted plan", beforePlan);

    const beforeApproval = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForCompleteFrameAfter("Continue implementation", beforeApproval);
    let screen = fixture.screen()?.join("\n") ?? "";
    expect(screen).toContain("Approved plan has not started");
    expect(screen).not.toContain("Approved Plan implementation complete.");

    const beforeDismiss = fixture.output().length;
    fixture.write("\u001b");
    await fixture.waitForCompleteFrameAfter("Plan approved · not started", beforeDismiss);
    const beforeReopen = fixture.output().length;
    fixture.write("Do not create a second approval command\r");
    await fixture.waitForCompleteFrameAfter("Continue implementation", beforeReopen);

    const beforeContinue = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForCompleteFrameAfter(
      "Approved Plan implementation completed.",
      beforeContinue,
    );
    screen = fixture.screen()?.join("\n") ?? "";
    expect(screen).toContain("Approved Plan implementation complete.");
    expect(screen).toContain("Approved Plan implementation completed.");

    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});
