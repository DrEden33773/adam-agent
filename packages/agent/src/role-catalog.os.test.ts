import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createManagedAgentControl } from "./managed-agent-control.js";
import { createInMemoryManagedAgentControlStore } from "./managed-agent-store.js";
import { createProjectExecutionDomain } from "./project-execution-domain.js";
import { createAgentRoleCatalog } from "./role-catalog.js";
import { createInMemorySessionStoreDirectory, type SessionRecord } from "./session-store.js";
import { createPermissionPolicy } from "./tool-runtime.js";

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

test("a new custom role keeps its explicit cumulative limit above the context window", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-role-budget-"));
  const directory = join(root, ".agents", "agents");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "budget.md"),
    "---\nname: Budgeted\ndescription: Read all requested evidence.\nbase: explore\nlimits: { maxTokens: 200000 }\n---\nRead every evidence step.\n",
  );
  await writeFile(join(root, "evidence.txt"), "role evidence\n");
  const domain = createProjectExecutionDomain({
    lifecycleOwner: {
      async acquire() {
        return { async release() {} };
      },
      async run(operation) {
        return operation();
      },
    },
  });
  const owner = await domain.claimRoot({ rootId: "project-runtime" });
  const parentSessionId = "00000000-0000-4000-8000-000000000001";
  let calls = 0;
  const control = createManagedAgentControl({
    parentSessionId,
    projectId: `sha256:${"d".repeat(64)}`,
    workspaceRoot: root,
    executionDomain: domain,
    store: createInMemoryManagedAgentControlStore(),
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    targetIdentity: {
      targetId: "role-fixture",
      vendor: "fixture",
      modelId: "fixture",
      route: "direct",
      profileVersion: 1,
      certification: "certified",
    },
    contextProfile: {
      version: 1,
      contextWindowTokens: 128000,
      maximumOutputTokens: 4096,
      compactAtTokens: 96000,
      postCompactTargetTokens: 32000,
      retainedTargetTokens: 8000,
      estimatorVersion: 1,
    },
    roleCatalog: createAgentRoleCatalog({
      workspaceRoot: root,
      userDirectory: join(root, "user"),
      projectTrusted: async () => true,
    }),
    model: {
      async *stream() {
        calls += 1;
        if (calls <= 5) {
          const id = `step-${calls}`;
          yield { type: "tool_call_start", id, name: "read_file" };
          yield { type: "tool_call_delta", id, json: '{"path":"evidence.txt"}' };
          yield { type: "tool_call_end", id };
          yield { type: "usage", inputTokens: 30000, outputTokens: 0 };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          yield { type: "text_delta", text: "All custom-role evidence steps completed." };
          yield { type: "usage", inputTokens: 30000, outputTokens: 0 };
          yield { type: "finish", reason: "stop" };
        }
      },
    },
  });
  try {
    expect(
      await control.dispatch({
        type: "spawn_agents",
        parentSessionId,
        mode: "foreground",
        entries: [
          { role: "project:Budgeted", task: "Read every step.", description: "Role evidence" },
        ],
      }),
    ).toMatchObject({
      status: "completed",
      results: [
        { outcome: { status: "completed", summary: "All custom-role evidence steps completed." } },
      ],
    });
    expect(calls).toBe(6);
  } finally {
    await control.dispatch({ type: "close", parentSessionId });
    await owner.release();
    await domain.close();
    await rm(root, { recursive: true, force: true });
  }
});
