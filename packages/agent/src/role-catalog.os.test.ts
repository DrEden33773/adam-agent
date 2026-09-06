import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createAgentRoleCatalog } from "./role-catalog.js";

test("catalog trust, strict narrowing, exact override and qualified collisions isolate malformed definitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-role-discovery-"));
  const project = join(root, "project");
  const directory = join(project, ".agents", "agents");
  const userDirectory = join(root, "user");
  await mkdir(directory, { recursive: true });
  await mkdir(userDirectory);
  let trusted = false;
  const catalog = createAgentRoleCatalog({
    workspaceRoot: project,
    userDirectory,
    projectTrusted: async () => trusted,
  });
  const definition = (name: string, extra = "") =>
    `---\nname: ${name}\ndescription: Inspect exact evidence.\nbase: explore\n${extra}---\nLocal instructions.\n`;
  try {
    await writeFile(join(userDirectory, "same.md"), definition("Auditor"));
    await writeFile(join(directory, "same.md"), definition("Auditor"));
    await writeFile(join(directory, "unsafe.md"), definition("Unsafe", "tools: [shell]\n"));
    await writeFile(join(directory, "unknown.md"), definition("Unknown", "secret_grant: true\n"));
    await writeFile(join(directory, "web.md"), definition("Web", "web: true\n"));
    await writeFile(join(directory, "explore.md"), definition("Explore"));
    await symlink(join(userDirectory, "same.md"), join(directory, "escape.md"));
    expect((await catalog.inspect()).roles.map((role) => role.qualifiedId)).toEqual([
      "builtin:explore",
      "builtin:research",
      "user:Auditor",
    ]);
    trusted = true;
    const loaded = await catalog.reload();
    expect(loaded.roles.map((role) => role.qualifiedId)).toEqual([
      "builtin:explore",
      "builtin:research",
      "user:Auditor",
      "project:Auditor",
    ]);
    expect(loaded.diagnostics.map((item) => item.source.split("/").at(-1)).sort()).toEqual([
      "escape.md",
      "explore.md",
      "unknown.md",
      "unsafe.md",
      "web.md",
    ]);
    await writeFile(
      join(directory, "explore.md"),
      definition("Explore", "overrides: builtin:explore\n"),
    );
    const reloaded = await catalog.reload();
    expect(reloaded.roles.map((role) => role.qualifiedId)).toEqual([
      "builtin:research",
      "user:Auditor",
      "project:Explore",
      "project:Auditor",
    ]);
    expect(loaded.roles.some((role) => role.qualifiedId === "builtin:explore")).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Owner role writes preserve conflicts and reject untrusted or redirected project sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-role-write-"));
  const workspaceRoot = join(root, "project");
  const userDirectory = join(root, "user");
  await mkdir(workspaceRoot);
  let trusted = false;
  const catalog = createAgentRoleCatalog({
    workspaceRoot,
    userDirectory,
    projectTrusted: async () => trusted,
  });
  const create = {
    action: "create",
    source: "project",
    fields: { name: "Audit", description: "Read evidence.", base: "explore", skills: false },
    instructions: "Read one file.",
  } as const;
  try {
    await expect(catalog.mutate(create)).rejects.toThrow("Trust the project");
    trusted = true;
    await symlink(userDirectory, join(workspaceRoot, ".agents"));
    await expect(catalog.mutate(create)).rejects.toThrow();
    await rm(join(workspaceRoot, ".agents"));
    const saved = await catalog.mutate(create);
    const role = saved.roles.find((role) => role.name === "Audit");
    expect(role?.tools).not.toContain("activate_skill");
    expect(role?.tools).not.toContain("read_skill_resource");
    await expect(catalog.mutate({ ...create, instructions: "Overwrite." })).rejects.toThrow(
      "already exists",
    );
    expect((await catalog.reload()).roles.find((role) => role.name === "Audit")?.instructions).toBe(
      "Read one file.",
    );
    await catalog.mutate({ ...create, source: "user" });
    expect(
      (await catalog.reload()).roles
        .filter((role) => role.name === "Audit")
        .map((role) => role.qualifiedId),
    ).toEqual(["user:Audit", "project:Audit"]);
    const builtin = saved.definitions?.find((role) => role.qualifiedId === "builtin:explore");
    if (builtin === undefined) throw new Error("Missing builtin.");
    await catalog.mutate({
      action: "toggle",
      qualifiedId: builtin.qualifiedId,
      definitionDigest: builtin.definitionDigest,
      enabled: false,
    });
    const fresh = createAgentRoleCatalog({
      workspaceRoot,
      userDirectory,
      projectTrusted: async () => trusted,
    });
    expect(
      (await fresh.inspect()).roles.some((role) => role.qualifiedId === builtin.qualifiedId),
    ).toBe(false);
    await fresh.mutate({
      action: "toggle",
      qualifiedId: builtin.qualifiedId,
      definitionDigest: builtin.definitionDigest,
      enabled: true,
    });
    expect(
      (await fresh.inspect()).roles.some((role) => role.qualifiedId === builtin.qualifiedId),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
