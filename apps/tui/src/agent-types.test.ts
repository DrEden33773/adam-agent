import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { startManagedTui } from "./agent-fleet.test-support.js";

test("Agent types creates a previewed project role and explicitly disables and reloads it", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-types-"));
  let calls = 0;
  const h = await startManagedTui(
    {
      async *stream() {
        calls += 1;
        yield { type: "finish", reason: "stop" };
      },
    },
    { workspaceRoot, rows: 40 },
  );
  try {
    await h.press("/agents", "/agents");
    await h.press("\r", "Agents workspace");
    await h.press("t", "Agent types");
    await h.press("n", "Name");
    await h.press("Auditor", "Auditor");
    await h.press("\r", "Description");
    await h.press("Inspect exact evidence.", "Inspect exact evidence.");
    await h.press("\r", "Base");
    for (const next of [
      "Tools",
      "Skills",
      "Web",
      "Context",
      "Target",
      "Thinking",
      "Limits",
      "Source",
      "Preview",
    ]) {
      await h.press("\r", next);
    }
    expect(calls).toBe(0);
    await expect(
      readFile(join(workspaceRoot, ".agents", "agents", "Auditor.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await h.press("\r", "Saved Auditor");
    const definition = await readFile(
      join(workspaceRoot, ".agents", "agents", "Auditor.md"),
      "utf8",
    );
    expect(definition).toContain("base: explore");
    expect(definition).toContain("Inspect exact evidence.");
    await h.press(" ", "Confirm disable Auditor");
    await h.press("\r", "Disabled Auditor");
    expect(h.presentation.getState().agentRoles?.some((role) => role.name === "Auditor")).toBe(
      false,
    );
    await h.press("r", "Reloaded");
    await h.press(" ", "Confirm enable Auditor");
    await h.press("\r", "Enabled Auditor");
    expect(h.presentation.getState().agentRoles?.some((role) => role.name === "Auditor")).toBe(
      true,
    );
    expect(calls).toBe(0);
  } finally {
    await h.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent types ejects an exact built-in override only after preview confirmation", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-eject-"));
  const h = await startManagedTui(
    {
      async *stream() {
        yield { type: "finish", reason: "stop" };
      },
    },
    { workspaceRoot, rows: 40 },
  );
  try {
    await h.press("/agents", "/agents");
    await h.press("\r", "Agents workspace");
    await h.press("t", "Agent types");
    await h.press("e", "Source");
    await h.press("\r", "Exact override: builtin:explore");
    await h.press("\x1b", "Agent types");
    await expect(
      readFile(join(workspaceRoot, ".agents", "agents", "Explore.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await h.press("e", "Source");
    await h.press("\r", "Exact override: builtin:explore");
    await h.press("\r", "Saved Explore");
    expect(
      await readFile(join(workspaceRoot, ".agents", "agents", "Explore.md"), "utf8"),
    ).toContain("overrides: builtin:explore");
    expect(h.presentation.getState().agentRoles?.map((role) => role.qualifiedId)).toEqual([
      "builtin:research",
      "project:Explore",
    ]);
    await h.press(" ", "Confirm disable Explore");
    await h.press("\r", "Disabled Explore");
    expect(h.presentation.getState().agentRoles?.map((role) => role.qualifiedId)).toEqual([
      "builtin:explore",
      "builtin:research",
    ]);
  } finally {
    await h.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
