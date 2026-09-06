import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRequest } from "@adam-agent/agent";
import {
  createPresentationPreferencesWithStorageForTesting,
  sessionManagedControl,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { startManagedTui } from "./agent-fleet.test-support.js";

test("an inherited role retains the parent's tightened context and output policy", async () => {
  const preferences = createPresentationPreferencesWithStorageForTesting({
    async read() {
      return {
        status: "available",
        text: JSON.stringify({
          schemaVersion: 2,
          defaultTargetId: null,
          modelPolicy: {
            contextWindowTokens: 64000,
            maximumOutputTokens: 1024,
            automaticCompactionWindowTokens: null,
          },
        }),
      };
    },
    async write() {},
  });
  const requests: ModelRequest[] = [];
  const h = await startManagedTui(
    {
      async *stream(request) {
        requests.push(request);
        yield { type: "text_delta", text: "Inherited policy evidence." };
        yield { type: "usage", inputTokens: 100, outputTokens: 20 };
        yield { type: "finish", reason: "stop" };
      },
    },
    { preferences },
  );
  try {
    await h.press("@Explore", "A · Explore");
    await h.press("\t", "@Explore");
    await h.press(" Inspect within the parent policy.\r", "Delegation");
    await h.press("\r", "Completed");
    const admission = (await h.store.read()).find((record) => record.event.type === "admitted");
    expect(admission?.event).toMatchObject({
      frozen: { contextProfile: { contextWindowTokens: 64000, maximumOutputTokens: 1024 } },
    });
    expect(requests[0]?.maximumOutputTokens).toBe(1024);
  } finally {
    await h.close();
  }
});

test("a trusted custom role admits only its narrowed tools and appends its instructions", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-role-catalog-"));
  const directory = join(workspaceRoot, ".agents", "agents");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "auditor.md"),
    "---\nname: Auditor\ndescription: Inspect one exact evidence file.\nbase: explore\ntools: [read_file]\nskills: false\ncontext_mode: task\n---\nAUDITOR INSTRUCTIONS: cite exact file evidence.\n",
  );
  const requests: ModelRequest[] = [];
  const h = await startManagedTui(
    {
      async *stream(request) {
        requests.push(request);
        yield {
          type: "text_delta",
          text: requests.length === 1 ? "Custom audit complete." : "Original audit continued.",
        };
        yield { type: "usage", inputTokens: 100, outputTokens: 20 };
        yield { type: "finish", reason: "stop" };
      },
    },
    { workspaceRoot },
  );
  try {
    const catalogControl = await h.lifecycle[sessionManagedControl](h.parent.sessionId);
    const discovered = await catalogControl?.dispatch({
      type: "list_agents",
      parentSessionId: h.parent.sessionId,
      view: "roles",
      limit: 2,
    });
    expect(discovered?.status).toBe("roles_listed");
    if (discovered?.status !== "roles_listed") throw new Error("Missing role catalog.");
    const customPage = await catalogControl?.dispatch({
      type: "list_agents",
      parentSessionId: h.parent.sessionId,
      view: "roles",
      ...(discovered.cursor === undefined ? {} : { cursor: discovered.cursor }),
    });
    expect(customPage).toMatchObject({
      status: "roles_listed",
      roles: [{ qualifiedId: "project:Auditor", tools: ["read_file"] }],
    });
    await h.press("@Auditor", "A · Inspect one exact evidence file.");
    await h.press("\t", "@Auditor");
    await h.press(" Inspect the evidence.", "Inspect the evidence.");
    await h.press("\r", "Delegation");
    await h.press("\r", "Completed");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["read_file"]);
    expect(JSON.stringify(requests[0]?.messages)).toContain("AUDITOR INSTRUCTIONS");
    const first = h.presentation.getState().authoritative.managedControl?.threads[0];
    expect(first?.role).toBe("project:Auditor");
    await writeFile(
      join(directory, "auditor.md"),
      "---\nname: Auditor\ndescription: Reloaded audit role.\nbase: explore\ntools: [search_repository]\n---\nRELOADED INSTRUCTIONS\n",
    );
    const control = await h.lifecycle[sessionManagedControl](h.parent.sessionId);
    const reloaded = await control?.inspectRoles({ reload: true });
    expect(reloaded?.roles.find((role) => role.qualifiedId === "project:Auditor")?.tools).toEqual([
      "search_repository",
    ]);
    await h.openFirstAgent("@auditor-1");
    await h.press("\r", "New turn");
    await h.press("Continue the original audit.", "Continue the original audit.");
    await h.press("\r", "Original audit continued.");
    expect(requests[1]?.tools.map((tool) => tool.name)).toEqual(["read_file"]);
    expect(JSON.stringify(requests[1]?.messages)).toContain("AUDITOR INSTRUCTIONS");
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("RELOADED INSTRUCTIONS");
  } finally {
    await h.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("a role uses its configured certified target and keeps it after definition reload", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-role-target-"));
  const directory = join(workspaceRoot, ".agents", "agents");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "specialist.md"),
    "---\nname: Specialist\ndescription: Inspect using the selected specialist target.\nbase: explore\nmodel: specialist.direct\n---\nSpecialist instructions.\n",
  );
  let mainCalls = 0;
  let childCalls = 0;
  const parentDriver = {
    async *stream() {
      mainCalls += 1;
      yield { type: "text_delta" as const, text: "Wrong target." };
      yield { type: "usage" as const, inputTokens: 100, outputTokens: 20 };
      yield { type: "finish" as const, reason: "stop" as const };
    },
  };
  const childDriver = {
    async *stream() {
      childCalls += 1;
      yield {
        type: "text_delta" as const,
        text: childCalls === 1 ? "Specialist completed." : "Specialist continued.",
      };
      yield { type: "usage" as const, inputTokens: 100, outputTokens: 20 };
      yield { type: "finish" as const, reason: "stop" as const };
    },
  };
  const profile = {
    version: 1 as const,
    contextWindowTokens: 128000,
    maximumOutputTokens: 4096,
    compactAtTokens: 96000,
    postCompactTargetTokens: 32000,
    retainedTargetTokens: 8000,
    estimatorVersion: 1 as const,
  };
  const parentTarget = {
    targetId: "deepseek-v4-flash.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-flash",
    route: "direct" as const,
    profileVersion: 1,
    certification: "certified" as const,
  };
  const specialistTarget = {
    ...parentTarget,
    targetId: "specialist.direct",
    modelId: "specialist",
  };
  const h = await startManagedTui(parentDriver, {
    workspaceRoot,
    modelTargets: {
      async resolve(input) {
        return {
          identity: input.targetId === specialistTarget.targetId ? specialistTarget : parentTarget,
          contextProfile: profile,
          driver: input.targetId === specialistTarget.targetId ? childDriver : parentDriver,
        };
      },
      async snapshot() {
        return {
          targets: [parentTarget, specialistTarget].map((identity) => ({
            identity,
            contextProfile: profile,
            readiness: { status: "available" as const, credentialSource: "test" },
          })),
        };
      },
    },
  });
  try {
    await h.press("@Specialist", "A · Inspect using");
    await h.press("\t", "@Specialist");
    await h.press(" Inspect specialist evidence.", "Inspect specialist evidence.");
    await h.press("\r", "Delegation");
    await h.press("\r", "Completed");
    expect(childCalls).toBe(1);
    expect(mainCalls).toBe(0);
    await writeFile(
      join(directory, "specialist.md"),
      "---\nname: Specialist\ndescription: Changed target.\nbase: explore\n---\nUpdated instructions.\n",
    );
    const control = await h.lifecycle[sessionManagedControl](h.parent.sessionId);
    await control?.inspectRoles({ reload: true });
    await h.openFirstAgent("@specialist-1");
    await h.press("\r", "New turn");
    await h.press("Continue specialist evidence.", "Continue specialist evidence.");
    await h.press("\r", "Specialist continued.");
    expect(childCalls).toBe(2);
    expect(mainCalls).toBe(0);
  } finally {
    await h.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test.each(
  (["inherit", "update", "cancel"] as const).flatMap((choice) =>
    [false, true].map((blankDraft) => ({ choice, blankDraft })),
  ),
)(
  "an unavailable role target offers $choice before admission (blank draft: $blankDraft)",
  async ({ choice, blankDraft }) => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-role-unavailable-"));
    const directory = join(workspaceRoot, ".agents", "agents");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "specialist.md");
    const original =
      "---\nname: Specialist\ndescription: Inspect with a configured target.\nbase: explore\nmodel: missing.direct\n---\nKeep these instructions.\n";
    await writeFile(path, original);
    let calls = 0;
    const h = await startManagedTui(
      {
        async *stream() {
          calls += 1;
          yield { type: "text_delta", text: "Explicit target choice completed." };
          yield { type: "usage", inputTokens: 100, outputTokens: 20 };
          yield { type: "finish", reason: "stop" };
        },
      },
      { workspaceRoot, blankDraft },
    );
    try {
      await h.press("@Specialist", "A · Inspect with");
      await h.press("\t", "@Specialist");
      await h.press(" Inspect evidence.", "Inspect evidence.");
      await h.press("\r", "Role target unavailable");
      expect(calls).toBe(0);
      expect(h.presentation.getState().authoritative.managedControl?.threads ?? []).toEqual([]);
      if (choice === "cancel") {
        await h.press("\x1b", "@Specialist");
        expect(await readFile(path, "utf8")).toBe(original);
        expect(calls).toBe(0);
      } else {
        if (choice === "update") {
          await h.press("\x1b[B", "Update");
          await h.press("\r", "Save this certified target");
        }
        await h.press("\r", "Delegation");
        expect(calls).toBe(0);
        const updated = await readFile(path, "utf8");
        expect(updated).toContain("Keep these instructions.");
        expect(updated).not.toContain("missing.direct");
        if (choice === "update") expect(updated).toContain("model: deepseek-v4-flash.direct");
        else expect(updated).not.toContain("model:");
        await h.press("\r", "Completed");
        expect(calls).toBe(1);
      }
    } finally {
      await h.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  },
);
