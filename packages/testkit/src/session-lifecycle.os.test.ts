import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCodingToolRegistry,
  createModelTargets,
  createPermissionPolicy,
  createReadToolRegistry,
  type ModelTargets,
  SessionLifecycleError,
  type ToolRegistry,
} from "@adam-agent/agent";
import {
  inputResourceIngestBarrier,
  openJsonlSessionStore,
  type SessionRecord,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { FakeModelDriver } from "./index.js";
import {
  sessionLifecycleAnswerOnlyDeepSeekStream as answerOnlyDeepSeekStream,
  sessionLifecycleBasePrompt as basePrompt,
  createSessionLifecycleForTests as createSessionLifecycle,
  sessionLifecycleSkillUsagePrompt as skillUsagePrompt,
  sessionLifecycleTargetIdentity as targetIdentity,
} from "./session-lifecycle.test-support.js";

const lifecycleOwnerFixturePath = fileURLToPath(
  new URL("../dist/session-lifecycle-owner.fixture.js", import.meta.url),
);

type ChildObservation = {
  readonly messages: unknown[];
  stderr: string;
};

const childObservations = new WeakMap<ChildProcess, ChildObservation>();

test("SessionLifecycle cold resume reads an immutable input resource after its source is deleted", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-input-resource-cold-resume-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "cold-source.txt");
  const runId = "30000000-0000-4000-8000-000000000011";
  const occurrenceId = `${runId}:input:1`;
  const content = "Cold resume keeps these immutable bytes.\n";
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, content, "utf8");
  let providerCalls = 0;
  const driver = new FakeModelDriver((request) => {
    providerCalls += 1;
    if (providerCalls === 1) {
      return [
        { type: "text_delta", text: "The immutable resource is linked." },
        { type: "finish", reason: "stop" },
      ];
    }
    if (providerCalls === 2) {
      expect(request.messages.filter((message) => message.role === "user")[0]?.content).toContain(
        occurrenceId,
      );
      return [
        { type: "tool_call_start", id: "cold-resource-call", name: "read_input_resource" },
        {
          type: "tool_call_delta",
          id: "cold-resource-call",
          json: JSON.stringify({ occurrenceId }),
        },
        { type: "tool_call_end", id: "cold-resource-call" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    expect(request.messages.at(-1)).toMatchObject({
      role: "tool",
      name: "read_input_resource",
      result: { status: "completed", output: { occurrenceId, content } },
    });
    return [
      { type: "text_delta", text: "The deleted source is still readable." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: targetIdentity,
        driver,
        contextProfile: {
          version: 1,
          contextWindowTokens: 1_000_000,
          maximumOutputTokens: 32_768,
          compactAtTokens: 800_000,
          postCompactTargetTokens: 200_000,
          retainedTargetTokens: 20_000,
          estimatorVersion: 1,
        },
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: {
              version: 1,
              contextWindowTokens: 1_000_000,
              maximumOutputTokens: 32_768,
              compactAtTokens: 800_000,
              postCompactTargetTokens: 200_000,
              retainedTargetTokens: 20_000,
              estimatorVersion: 1,
            },
          },
        ],
      };
    },
  };
  const first = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;

  try {
    const admitted = await first.admit({
      targetIdentity,
      input: { text: "Link this source." },
      resourceSelections: [{ type: "local_file", path: selectedPath }],
      runId,
    });
    await first.close();
    await unlink(selectedPath);

    cold = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
    await expect(
      cold.continue({
        sessionId: admitted.snapshot.sessionId,
        input: { text: "Read the linked source after restart." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "The deleted source is still readable." },
    });
    expect(providerCalls).toBe(3);
  } finally {
    await cold?.close();
    await first.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a corrupt immutable input resource before cold provider projection", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-input-resource-corrupt-resume-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "corrupt-source.txt");
  const content = "Integrity must remain exact.\n";
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, content, "utf8");
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return [
      { type: "text_delta", text: "Linked." },
      { type: "finish", reason: "stop" },
    ];
  });
  const contextProfile = {
    version: 1 as const,
    contextWindowTokens: 1_000_000,
    maximumOutputTokens: 32_768,
    compactAtTokens: 800_000,
    postCompactTargetTokens: 200_000,
    retainedTargetTokens: 20_000,
    estimatorVersion: 1 as const,
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const first = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;

  try {
    const admitted = await first.admit({
      targetIdentity,
      input: { text: "Link integrity evidence." },
      resourceSelections: [{ type: "local_file", path: selectedPath }],
    });
    await first.close();
    const artifactPath = join(stateRoot, "artifacts", digest);
    await chmod(artifactPath, 0o600);
    await writeFile(artifactPath, "same-size-corrupt-bytes!!\n", "utf8");

    cold = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
    await expect(
      cold.continue({
        sessionId: admitted.snapshot.sessionId,
        input: { text: "Do not project corrupt bytes." },
      }),
    ).rejects.toMatchObject({ code: "input_resource_corrupt" });
    expect(providerCalls).toBe(1);
  } finally {
    await cold?.close();
    await first.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a missing immutable input resource before cold provider projection", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-input-resource-missing-resume-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "missing-source.txt");
  const content = "The immutable artifact must remain present.\n";
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, content, "utf8");
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return [
      { type: "text_delta", text: "Linked." },
      { type: "finish", reason: "stop" },
    ];
  });
  const contextProfile = {
    version: 1 as const,
    contextWindowTokens: 1_000_000,
    maximumOutputTokens: 32_768,
    compactAtTokens: 800_000,
    postCompactTargetTokens: 200_000,
    retainedTargetTokens: 20_000,
    estimatorVersion: 1 as const,
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const first = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;

  try {
    const admitted = await first.admit({
      targetIdentity,
      input: { text: "Link presence evidence." },
      resourceSelections: [{ type: "local_file", path: selectedPath }],
    });
    await first.close();
    await unlink(join(stateRoot, "artifacts", digest));

    cold = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
    await expect(
      cold.continue({
        sessionId: admitted.snapshot.sessionId,
        input: { text: "Do not project a missing artifact." },
      }),
    ).rejects.toMatchObject({ code: "input_resource_corrupt" });
    expect(providerCalls).toBe(1);
  } finally {
    await cold?.close();
    await first.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a selected FIFO without waiting for a writer", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-input-resource-fifo-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const fifoPath = join(testRoot, "selected.pipe");
  await mkdir(workspaceRoot);
  execFileSync("mkfifo", [fifoPath]);
  let providerCalls = 0;
  const contextProfile = {
    version: 1 as const,
    contextWindowTokens: 1_000_000,
    maximumOutputTokens: 32_768,
    compactAtTokens: 800_000,
    postCompactTargetTokens: 200_000,
    retainedTargetTokens: 20_000,
    estimatorVersion: 1 as const,
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: targetIdentity,
        driver: new FakeModelDriver(() => {
          providerCalls += 1;
          return [{ type: "finish", reason: "stop" }];
        }),
        contextProfile,
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Reject the FIFO." },
        resourceSelections: [{ type: "local_file", path: fifoPath }],
      }),
    ).rejects.toMatchObject({ code: "input_resource_invalid_selection" });
    expect(providerCalls).toBe(0);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects an input resource above the exact eight MiB file bound", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-input-resource-file-bound-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "too-large.txt");
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, "", "utf8");
  await truncate(selectedPath, 8 * 1024 * 1024 + 1);
  let providerCalls = 0;
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () => {
      providerCalls += 1;
      throw new Error("Provider dispatch is forbidden for an over-limit resource.");
    },
  });
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Reject this over-limit resource." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
      }),
    ).rejects.toMatchObject({ code: "input_resource_too_large" });
    expect(providerCalls).toBe(0);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects input resources above the exact sixteen MiB run aggregate", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-input-resource-aggregate-bound-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const firstPath = join(testRoot, "first.txt");
  const secondPath = join(testRoot, "second.txt");
  const overflowPath = join(testRoot, "overflow.txt");
  await mkdir(workspaceRoot);
  await writeFile(firstPath, "", "utf8");
  await writeFile(secondPath, "", "utf8");
  await writeFile(overflowPath, "x", "utf8");
  await truncate(firstPath, 8 * 1024 * 1024);
  await truncate(secondPath, 8 * 1024 * 1024);
  let providerCalls = 0;
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () => {
      providerCalls += 1;
      throw new Error("Provider dispatch is forbidden for aggregate overflow.");
    },
  });
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Reject the aggregate overflow." },
        resourceSelections: [
          { type: "local_file", path: firstPath },
          { type: "local_file", path: secondPath },
          { type: "local_file", path: overflowPath },
        ],
      }),
    ).rejects.toMatchObject({ code: "input_resource_aggregate_too_large" });
    expect(providerCalls).toBe(0);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects input resources above the exact sixty-four MiB lineage aggregate", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-input-resource-lineage-aggregate-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const firstPath = join(testRoot, "first.txt");
  const secondPath = join(testRoot, "second.txt");
  const overflowPath = join(testRoot, "overflow.txt");
  await mkdir(workspaceRoot);
  await writeFile(firstPath, "", "utf8");
  await writeFile(secondPath, "", "utf8");
  await writeFile(overflowPath, "x", "utf8");
  await truncate(firstPath, 8 * 1024 * 1024);
  await truncate(secondPath, 8 * 1024 * 1024);
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return [
      { type: "text_delta", text: "Accepted the exact lineage byte boundary." },
      { type: "finish", reason: "stop" },
    ];
  });
  const contextProfile = {
    version: 1 as const,
    contextWindowTokens: 1_000_000,
    maximumOutputTokens: 32_768,
    compactAtTokens: 800_000,
    postCompactTargetTokens: 200_000,
    retainedTargetTokens: 20_000,
    estimatorVersion: 1 as const,
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const created = await lifecycle.create({ targetIdentity });
    let lastSequence = created.lastSequence;
    for (let index = 0; index < 4; index += 1) {
      const continued = await lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: `Commit lineage byte batch ${index + 1}.` },
        resourceSelections: [
          { type: "local_file", path: firstPath },
          { type: "local_file", path: secondPath },
        ],
      });
      lastSequence = continued.snapshot.lastSequence;
    }

    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Reject the lineage aggregate overflow." },
        resourceSelections: [{ type: "local_file", path: overflowPath }],
      }),
    ).rejects.toMatchObject({ code: "input_resource_aggregate_too_large" });
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      lastSequence,
    });
    expect(providerCalls).toBe(4);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle follows one selected symlink without persisting its source path", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-input-resource-symlink-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const targetPath = join(testRoot, "private-target.txt");
  const selectedPath = join(testRoot, "selected-link.txt");
  await mkdir(workspaceRoot);
  await writeFile(targetPath, "selected through one controlled symlink\n", "utf8");
  await symlink(targetPath, selectedPath);
  const requests: unknown[] = [];
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  });
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const admitted = await lifecycle.admit({
      targetIdentity,
      input: { text: "Link the explicitly selected file." },
      resourceSelections: [{ type: "local_file", path: selectedPath }],
    });
    expect(admitted.result).toMatchObject({ status: "completed" });
    expect(JSON.stringify(requests)).not.toContain(testRoot);
    const store = await openJsonlSessionStore({
      stateRoot,
      workspaceRoot,
      sessionId: admitted.snapshot.sessionId,
    });
    const serializedRecords = JSON.stringify(await store.read());
    expect(serializedRecords).not.toContain(testRoot);
    expect(serializedRecords).toContain('"displayName":"selected-link.txt"');
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a dangling selected symlink before provider dispatch", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-input-resource-dangling-symlink-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "dangling-link.txt");
  await mkdir(workspaceRoot);
  await symlink(join(testRoot, "missing-target.txt"), selectedPath);
  let providerCalls = 0;
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () => {
      providerCalls += 1;
      throw new Error("Provider dispatch is forbidden for a dangling symlink.");
    },
  });
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Reject the dangling selection." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
      }),
    ).rejects.toMatchObject({ code: "input_resource_invalid_selection" });
    expect(providerCalls).toBe(0);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a looping selected symlink before provider dispatch", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-input-resource-looping-symlink-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "looping-link.txt");
  await mkdir(workspaceRoot);
  await symlink(selectedPath, selectedPath);
  let providerCalls = 0;
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () => {
      providerCalls += 1;
      throw new Error("Provider dispatch is forbidden for a looping symlink.");
    },
  });
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Reject the looping selection." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
      }),
    ).rejects.toMatchObject({ code: "input_resource_invalid_selection" });
    expect(providerCalls).toBe(0);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a final symlink substituted after controlled resolution", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-input-resource-symlink-race-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const targetPath = join(testRoot, "accepted-target.txt");
  const replacementPath = join(testRoot, "replacement.txt");
  const selectedPath = join(testRoot, "selected-link.txt");
  await mkdir(workspaceRoot);
  await writeFile(targetPath, "accepted target\n", "utf8");
  await writeFile(replacementPath, "must not be followed\n", "utf8");
  await symlink(targetPath, selectedPath);
  let providerCalls = 0;
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () => {
      providerCalls += 1;
      throw new Error("Provider dispatch is forbidden after final-path substitution.");
    },
  });
  const lifecycle = createSessionLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    [inputResourceIngestBarrier]: {
      async afterResolved() {
        await unlink(targetPath);
        await symlink(replacementPath, targetPath);
      },
    },
  });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Do not follow a substituted final symlink." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
      }),
    ).rejects.toMatchObject({ code: "input_resource_invalid_selection" });
    expect(providerCalls).toBe(0);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle cold resume keeps a Direct DeepSeek v2 session on its historical profile", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-deepseek-v2-cold-resume-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const historicalIdentity = { ...targetIdentity, profileVersion: 2 } as const;
  const requests: unknown[] = [];
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  });
  const currentTools = createCodingToolRegistry({ stateRoot, workspaceRoot });
  const historicalToolNames = new Set([
    "read_file",
    "write_file",
    "edit_file",
    "run_shell",
    "activate_skill",
    "read_skill_resource",
  ]);
  const historicalTools: ToolRegistry = {
    definitions: () =>
      currentTools.definitions().filter((definition) => historicalToolNames.has(definition.name)),
    resolve: (name) => (historicalToolNames.has(name) ? currentTools.resolve(name) : undefined),
  };
  const first = createSessionLifecycle({
    modelTargets,
    stateRoot,
    tools: historicalTools,
    workspaceRoot,
  });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;

  try {
    const created = await first.create({ targetIdentity: historicalIdentity });
    await expect(
      first.continue({
        sessionId: created.sessionId,
        input: { text: "Record one historical turn." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "Hello, Adam." },
      snapshot: { targetIdentity: historicalIdentity },
    });
    await first.close();

    cold = createSessionLifecycle({ modelTargets, stateRoot, tools: currentTools, workspaceRoot });
    await expect(
      cold.continue({
        sessionId: created.sessionId,
        input: { text: "Continue the historical session." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "Hello, Adam." },
      snapshot: { targetIdentity: historicalIdentity },
    });

    expect(
      requests.map((request) => {
        const body = request as {
          readonly max_tokens?: number;
          readonly messages?: readonly { readonly role?: string; readonly content?: string }[];
          readonly model?: string;
          readonly tools?: readonly { readonly function?: { readonly name?: string } }[];
        };
        return {
          maxTokens: body.max_tokens,
          model: body.model,
          toolNames: body.tools?.map((tool) => tool.function?.name),
          userMessages: body.messages
            ?.filter((message) => message.role === "user")
            .map((message) => message.content),
        };
      }),
    ).toEqual([
      {
        maxTokens: 384_000,
        model: "deepseek-v4-flash",
        toolNames: [
          "read_file",
          "write_file",
          "edit_file",
          "run_shell",
          "activate_skill",
          "read_skill_resource",
        ],
        userMessages: ["Record one historical turn."],
      },
      {
        maxTokens: 384_000,
        model: "deepseek-v4-flash",
        toolNames: [
          "read_file",
          "write_file",
          "edit_file",
          "run_shell",
          "activate_skill",
          "read_skill_resource",
        ],
        userMessages: ["Record one historical turn.", "Continue the historical session."],
      },
    ]);
  } finally {
    await cold?.close();
    await first.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a competing project writer before model dispatch and takes over after owner death", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-owner-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const bootstrap = createSessionLifecycle({ stateRoot, workspaceRoot });
  const created = await bootstrap.create({ targetIdentity });
  const owner = spawn(process.execPath, [lifecycleOwnerFixturePath], {
    env: {
      ...process.env,
      ADAM_AGENT_FIXTURE_SESSION_ID: created.sessionId,
      ADAM_AGENT_FIXTURE_STATE_ROOT: stateRoot,
      ADAM_AGENT_FIXTURE_WORKSPACE_ROOT: workspaceRoot,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  observeChild(owner);

  try {
    await waitForChildMessage(owner, "provider-started");
    const inspectedWhileOwned = await bootstrap.inspect({ sessionId: created.sessionId });
    let competingModelRequests = 0;
    const contender = createSessionLifecycle({
      modelTargets: createModelTargets({
        environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
        fetch: async () => {
          competingModelRequests += 1;
          return new Response(answerOnlyDeepSeekStream, {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          });
        },
      }),
      stateRoot,
      workspaceRoot,
    });

    const competing = contender.continue({ sessionId: created.sessionId });
    await expect(competing).rejects.toBeInstanceOf(SessionLifecycleError);
    await expect(competing).rejects.toMatchObject({ code: "project_in_use" });
    expect(inspectedWhileOwned).toEqual(
      expect.objectContaining({ sessionId: created.sessionId, status: "interrupted" }),
    );
    expect(competingModelRequests).toBe(0);

    owner.kill("SIGKILL");
    await waitForChildClose(owner);
    const takeover = await contender.resume({ sessionId: created.sessionId });

    expect({ competingModelRequests, takeover }).toEqual({
      competingModelRequests: 0,
      takeover: expect.objectContaining({
        status: "ready",
        snapshot: expect.objectContaining({
          status: "interrupted",
          run: expect.objectContaining({
            lastAttempt: { turn: 1, attempt: 1, status: "interrupted" },
          }),
        }),
      }),
    });
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill("SIGKILL");
      await waitForChildClose(owner);
    }
    await rm(testRoot, { recursive: true, force: true });
  }
}, 20_000);

test("SessionLifecycle real-process continuation preserves a completed safe read and starts a new attempt", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-real-safe-replay-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "# Real restart\n", "utf8");
  const created = await createSessionLifecycle({
    stateRoot,
    workspaceRoot,
    tools: createReadToolRegistry({ workspaceRoot }),
  }).create({ targetIdentity });
  const owner = spawn(process.execPath, [lifecycleOwnerFixturePath], {
    env: {
      ...process.env,
      ADAM_AGENT_FIXTURE_MODE: "safe-read-then-hang",
      ADAM_AGENT_FIXTURE_SESSION_ID: created.sessionId,
      ADAM_AGENT_FIXTURE_STATE_ROOT: stateRoot,
      ADAM_AGENT_FIXTURE_WORKSPACE_ROOT: workspaceRoot,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  observeChild(owner);

  try {
    await waitForChildMessage(owner, "provider-started");
    owner.kill("SIGKILL");
    await waitForChildClose(owner);
    const requests: unknown[] = [];
    const lifecycle = createSessionLifecycle({
      modelTargets: createModelTargets({
        environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
        fetch: async (_input, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return new Response(answerOnlyDeepSeekStream, {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          });
        },
      }),
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      tools: createReadToolRegistry({ workspaceRoot }),
      workspaceRoot,
    });
    const hydrated = await lifecycle.resume({ sessionId: created.sessionId });
    const continued = await lifecycle.continue({ sessionId: created.sessionId });
    const persisted = await openJsonlSessionStore<SessionRecord>({
      stateRoot,
      workspaceRoot,
      sessionId: created.sessionId,
    }).then((store) => store.read());

    expect({
      hydrated,
      continued,
      providerMessages: requests,
      userMessages: persisted.filter(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "runtime_event" &&
          record.record.event.type === "user_message",
      ).length,
      completedReads: persisted.filter(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "runtime_event" &&
          record.record.event.type === "tool_completed" &&
          record.record.event.name === "read_file",
      ).length,
    }).toEqual({
      hydrated: expect.objectContaining({
        status: "ready",
        snapshot: expect.objectContaining({
          status: "interrupted",
          run: expect.objectContaining({
            lastAttempt: { turn: 2, attempt: 1, status: "interrupted" },
          }),
        }),
      }),
      continued: expect.objectContaining({
        result: { status: "completed", answer: "Hello, Adam." },
        snapshot: expect.objectContaining({
          run: expect.objectContaining({
            lastAttempt: { turn: 2, attempt: 2, status: "completed" },
          }),
        }),
      }),
      providerMessages: [
        expect.objectContaining({
          messages: [
            { role: "system", content: basePrompt },
            { role: "system", content: `Developer instruction:\n${skillUsagePrompt}` },
            { role: "user", content: "Read the project" },
            expect.objectContaining({ role: "assistant" }),
            expect.objectContaining({ role: "tool", tool_call_id: "read-before-crash" }),
          ],
        }),
      ],
      userMessages: 1,
      completedReads: 1,
    });
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill("SIGKILL");
      await waitForChildClose(owner);
    }
    await rm(testRoot, { recursive: true, force: true });
  }
}, 20_000);

test("SessionLifecycle real-process restart marks a killed structured patch as indeterminate without replay", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-real-patch-crash-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "source.txt"), "source\n", "utf8");
  const created = await createSessionLifecycle({
    stateRoot,
    workspaceRoot,
    tools: createCodingToolRegistry({ stateRoot, workspaceRoot }),
  }).create({ targetIdentity });
  const owner = spawn(process.execPath, [lifecycleOwnerFixturePath], {
    env: {
      ...process.env,
      ADAM_AGENT_FIXTURE_MODE: "patch-rename-then-hang",
      ADAM_AGENT_FIXTURE_SESSION_ID: created.sessionId,
      ADAM_AGENT_FIXTURE_STATE_ROOT: stateRoot,
      ADAM_AGENT_FIXTURE_WORKSPACE_ROOT: workspaceRoot,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  observeChild(owner);

  try {
    await waitForChildMessage(owner, "patch-renamed");
    owner.kill("SIGKILL");
    await waitForChildClose(owner);
    let modelRequests = 0;
    const lifecycle = createSessionLifecycle({
      modelTargets: createModelTargets({
        environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
        fetch: async () => {
          modelRequests += 1;
          return new Response(answerOnlyDeepSeekStream, {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          });
        },
      }),
      permissions: createPermissionPolicy({ allowedEffects: ["write"] }),
      stateRoot,
      tools: createCodingToolRegistry({ stateRoot, workspaceRoot }),
      workspaceRoot,
    });
    const resumed = await lifecycle.resume({ sessionId: created.sessionId });

    expect({
      modelRequests,
      resumed,
      source: await readFile(join(workspaceRoot, "source.txt"), "utf8"),
      destination: await readFile(join(workspaceRoot, "destination.txt"), "utf8"),
    }).toEqual({
      modelRequests: 0,
      resumed: expect.objectContaining({
        status: "ready",
        snapshot: expect.objectContaining({
          status: "settled",
          run: expect.objectContaining({
            result: {
              status: "failed",
              error: {
                code: "tool_effect_indeterminate",
                reason: "process_restart",
                message:
                  "The edit_file effect started before restart and cannot be replayed safely.",
              },
            },
          }),
        }),
      }),
      source: "source\n",
      destination: "source\n",
    });
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill("SIGKILL");
      await waitForChildClose(owner);
    }
    await rm(testRoot, { recursive: true, force: true });
  }
}, 20_000);

test("SessionLifecycle real-process branch writes independently, survives restart, and stays project-scoped", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-real-branch-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const otherWorkspaceRoot = join(testRoot, "other-workspace");
  await mkdir(workspaceRoot);
  await mkdir(otherWorkspaceRoot);
  const lifecycle = createSessionLifecycle({
    modelTargets: createModelTargets({
      environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
      fetch: async () =>
        new Response(answerOnlyDeepSeekStream, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        }),
    }),
    stateRoot,
    workspaceRoot,
  });
  const parent = await lifecycle.create({ targetIdentity });
  const parentRun = await lifecycle.continue({
    sessionId: parent.sessionId,
    input: { text: "Create the parent boundary" },
  });
  const parentPath = join(
    stateRoot,
    "projects",
    parent.projectId.replace(/^sha256:/u, ""),
    "sessions",
    `${parent.sessionId}.jsonl`,
  );
  const parentBefore = await readFile(parentPath, "utf8");
  const branchProcess = spawn(process.execPath, [lifecycleOwnerFixturePath], {
    env: {
      ...process.env,
      ADAM_AGENT_FIXTURE_AT_SEQUENCE: String(parentRun.snapshot.lastSequence),
      ADAM_AGENT_FIXTURE_MODE: "branch-child-complete",
      ADAM_AGENT_FIXTURE_SESSION_ID: parent.sessionId,
      ADAM_AGENT_FIXTURE_STATE_ROOT: stateRoot,
      ADAM_AGENT_FIXTURE_WORKSPACE_ROOT: workspaceRoot,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  observeChild(branchProcess);

  try {
    // Terminal IPC is causally published before close and must remain observable afterward.
    await waitForChildClose(branchProcess);
    const branchMessage = await waitForFixtureRecord<{
      readonly type: "branch-child-completed";
      readonly child: CurrentSessionSnapshotForFixture;
      readonly continued: { readonly result: { readonly status: string } };
    }>(branchProcess, "branch-child-completed");
    const childId = branchMessage.child.sessionId;
    const childStore = await openJsonlSessionStore<SessionRecord>({
      stateRoot,
      workspaceRoot,
      sessionId: childId,
    });
    const childRecords = await childStore.read();
    const inspectProcess = spawn(process.execPath, [lifecycleOwnerFixturePath], {
      env: {
        ...process.env,
        ADAM_AGENT_FIXTURE_MODE: "inspect-only",
        ADAM_AGENT_FIXTURE_SESSION_ID: childId,
        ADAM_AGENT_FIXTURE_STATE_ROOT: stateRoot,
        ADAM_AGENT_FIXTURE_WORKSPACE_ROOT: workspaceRoot,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    observeChild(inspectProcess);
    const inspected = await waitForFixtureRecord<{
      readonly type: "session-inspected";
      readonly resumed: { readonly status: string; readonly snapshot: { readonly status: string } };
    }>(inspectProcess, "session-inspected");
    await waitForChildClose(inspectProcess);
    const crossProjectProcess = spawn(process.execPath, [lifecycleOwnerFixturePath], {
      env: {
        ...process.env,
        ADAM_AGENT_FIXTURE_MODE: "inspect-only",
        ADAM_AGENT_FIXTURE_SESSION_ID: childId,
        ADAM_AGENT_FIXTURE_STATE_ROOT: stateRoot,
        ADAM_AGENT_FIXTURE_WORKSPACE_ROOT: otherWorkspaceRoot,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    observeChild(crossProjectProcess);
    const crossProject = await waitForFixtureRecord<{
      readonly type: "session-inspection-failed";
      readonly code: string;
    }>(crossProjectProcess, "session-inspection-failed");
    await waitForChildClose(crossProjectProcess);

    expect({
      branchMessage,
      inspected,
      crossProject,
      parentUnchanged: (await readFile(parentPath, "utf8")) === parentBefore,
      childRecordCount: childRecords.length,
    }).toEqual({
      branchMessage: expect.objectContaining({
        child: expect.objectContaining({
          sessionId: expect.not.stringMatching(new RegExp(`^${parent.sessionId}$`, "u")),
          lineage: expect.objectContaining({
            parentSessionId: parent.sessionId,
            parentEventPosition: parentRun.snapshot.lastSequence,
          }),
        }),
        continued: expect.objectContaining({
          result: { status: "completed", answer: "Child completed." },
        }),
      }),
      inspected: expect.objectContaining({
        resumed: expect.objectContaining({
          status: "ready",
          snapshot: expect.objectContaining({ sessionId: childId, status: "settled" }),
        }),
      }),
      crossProject: { type: "session-inspection-failed", code: "session_not_found" },
      parentUnchanged: true,
      childRecordCount: 8,
    });
  } finally {
    for (const child of [branchProcess]) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForChildClose(child);
      }
    }
    await rm(testRoot, { recursive: true, force: true });
  }
}, 20_000);

type CurrentSessionSnapshotForFixture = {
  readonly sessionId: string;
  readonly lineage?: {
    readonly parentSessionId: string;
    readonly parentEventPosition: number;
  };
};

function observeChild(child: ChildProcess): void {
  const observation: ChildObservation = { messages: [], stderr: "" };
  childObservations.set(child, observation);
  child.on("message", (message) => observation.messages.push(message));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    observation.stderr += chunk;
  });
}

async function waitForChildMessage(
  child: ReturnType<typeof spawn>,
  expectedMessage: string,
): Promise<void> {
  const observation = requiredChildObservation(child);
  if (observation.messages.includes(expectedMessage)) {
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `Child closed before readiness: code=${String(child.exitCode)} signal=${String(child.signalCode)}. ${observation.stderr}`,
    );
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      cleanup();
      reject(new Error(`Timed out waiting for ${expectedMessage}. stderr: ${observation.stderr}`));
    }, 10_000);
    const onMessage = (message: unknown) => {
      if (message === expectedMessage) {
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Child closed before readiness: code=${String(code)} signal=${String(signal)}. ${observation.stderr}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("close", onClose);
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

async function waitForFixtureRecord<RecordType extends { readonly type: string }>(
  child: ReturnType<typeof spawn>,
  expectedType: RecordType["type"],
): Promise<RecordType> {
  const observation = requiredChildObservation(child);
  const existing = observation.messages.find(
    (message) => isFixtureRecord(message) && message.type === expectedType,
  );
  if (isFixtureRecord(existing)) {
    return existing as RecordType;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `Child closed before ${expectedType}: code=${String(child.exitCode)} signal=${String(child.signalCode)}. ${observation.stderr}`,
    );
  }
  return new Promise<RecordType>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      cleanup();
      reject(new Error(`Timed out waiting for ${expectedType}. stderr: ${observation.stderr}`));
    }, 10_000);
    const onMessage = (message: unknown) => {
      if (isFixtureRecord(message) && message.type === expectedType) {
        cleanup();
        resolve(message as RecordType);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Child closed before ${expectedType}: code=${String(code)} signal=${String(signal)}. ${observation.stderr}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("close", onClose);
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

async function waitForChildClose(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      cleanup();
      reject(new Error("Timed out waiting for child closure."));
    }, 10_000);
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("close", onClose);
    };
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function requiredChildObservation(child: ChildProcess): ChildObservation {
  const observation = childObservations.get(child);
  if (observation === undefined) {
    throw new Error("The child process was not registered with the fixture collector.");
  }
  return observation;
}

function isFixtureRecord(value: unknown): value is Record<string, unknown> & {
  readonly type?: unknown;
} {
  return typeof value === "object" && value !== null;
}
