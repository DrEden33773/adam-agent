import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentSession,
  type ArtifactStore,
  createCodingToolRegistry,
  createFileArtifactStore,
  createInMemorySessionStore,
  createJsonlSessionStore,
  createPermissionPolicy,
  createReadToolRegistry,
  type ModelDriver,
  ModelDriverError,
  type ModelRequest,
  type ModelTargets,
  OpenAICompatibleModelDriver,
  type RuntimeEvent,
  type SessionStore,
  type ToolRegistry,
} from "@adam-agent/agent";
import {
  type ContextProfile,
  createPromptContextV1,
  digestContextRecordPrefix,
  openJsonlSessionStore,
  preparedDirectDeepSeekV2ContextProfile,
  type SessionContextCompactionCommittedRecord,
  type SessionContextCompactionFailedRecord,
  type SessionContextCompactionInterruptedRecord,
  type SessionRecord,
  sessionDurableContext,
  sessionDurableOutputLimits,
} from "@adam-agent/agent/internal-testing";
import { expect, expectTypeOf, test } from "vitest";
import { createSessionLifecycleForTesting as createSessionLifecycle } from "./index.js";

const { ADAM_AGENT_LARGE_OUTPUT_TESTS: largeOutputTests } = process.env;
const largeOutputTest = test.skipIf(largeOutputTests !== "1");

const targetIdentity = {
  targetId: "fake.local",
  vendor: "adam",
  modelId: "fake",
  route: "direct",
  profileVersion: 1,
  certification: "certified",
} as const;

const contextProfile: ContextProfile = {
  version: 1,
  contextWindowTokens: 20_000,
  maximumOutputTokens: 100,
  compactAtTokens: 500,
  postCompactTargetTokens: 400,
  retainedTargetTokens: 100,
  estimatorVersion: 1,
};
const roomyContextProfile: ContextProfile = {
  ...contextProfile,
  compactAtTokens: 15_000,
  postCompactTargetTokens: 10_000,
  retainedTargetTokens: 1_000,
};

test("ModelRequest requires an explicit per-call output budget", () => {
  expectTypeOf<ModelRequest["maximumOutputTokens"]>().toEqualTypeOf<number>();
});

function deepSeekTextStream(text: string): string {
  const delta = JSON.stringify({
    id: "budget-fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek-v4-flash",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  });
  const finish = JSON.stringify({
    id: "budget-fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek-v4-flash",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  return `data: ${delta}\n\ndata: ${finish}\n\ndata: [DONE]\n\n`;
}

test("AgentSession sends the v1 ordinary output budget with each model request", async () => {
  let observedMaximumOutputTokens: number | undefined;
  const model: ModelDriver = {
    async *stream(request) {
      observedMaximumOutputTokens = request.maximumOutputTokens;
      yield { type: "text_delta", text: "Budget observed." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const dependencies = {
    model,
    store: createInMemorySessionStore(),
    contextProfile: contextProfile,
  };
  const session = new AgentSession(dependencies);

  await expect(session.run({ text: "Use the active model profile." })).resolves.toEqual({
    status: "completed",
    answer: "Budget observed.",
  });
  expect(observedMaximumOutputTokens).toBe(100);
});

test("AgentSession persists an answer above 256 KiB by durable artifact before publishing it", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-model-response-artifact-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const sessionId = "model-response-artifact";
  const projectId = "a".repeat(64);
  const answer = "a".repeat(256 * 1024 + 1);
  await mkdir(workspaceRoot);
  const artifactStore = await createFileArtifactStore({ root: join(stateRoot, "artifacts") });
  const jsonlStore = await createJsonlSessionStore<SessionRecord>({
    stateRoot,
    workspaceRoot,
    sessionId,
  });
  const durabilityOrder: string[] = [];
  const store: SessionStore<SessionRecord> = {
    async append(record) {
      const candidate = record as unknown as {
        readonly record?: {
          readonly type?: string;
          readonly response?: {
            readonly text?: {
              readonly storage?: string;
              readonly reference?: { readonly id: string };
            };
          };
        };
      };
      const reference = candidate.record?.response?.text?.reference;
      if (candidate.record?.type === "model_response_completed" && reference !== undefined) {
        durabilityOrder.push(
          (await artifactStore.read(reference.id)) === undefined
            ? "missing-before-reference"
            : "artifact-before-reference",
        );
      }
      await jsonlStore.append(record);
      if (candidate.record?.type === "model_response_completed" && reference !== undefined) {
        durabilityOrder.push("response-reference");
      }
    },
    read: () => jsonlStore.read(),
  };
  const model: ModelDriver = {
    async *stream() {
      yield { type: "text_delta", text: answer };
      yield { type: "finish", reason: "stop" };
    },
  };
  const dependencies = {
    model,
    artifactStore,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    contextProfile,
    [sessionDurableContext]: {
      nextSequence: 1,
      targetIdentity,
      projectId,
      sessionId,
    },
  };
  const session = new AgentSession(dependencies);
  const completedAnswers: string[] = [];
  session.subscribe((event) => {
    if (event.type === "model_message_completed") {
      completedAnswers.push(event.text);
    }
  });

  try {
    await expect(session.run({ text: "Return the large answer." })).resolves.toEqual({
      status: "completed",
      answer,
    });
    const records = await jsonlStore.read();
    const responseIndex = records.findIndex(
      (record) => record.schemaVersion === 3 && record.record.type === "model_response_completed",
    );
    const publicationIndex = records.findIndex(
      (record) =>
        record.schemaVersion === 3 &&
        (record.record as { readonly type: string }).type === "model_response_published",
    );
    const responseRecord = records[responseIndex] as unknown as {
      readonly record: {
        readonly response: {
          readonly recordVersion: number;
          readonly text: {
            readonly storage: string;
            readonly reference: {
              readonly id: string;
              readonly byteCount: number;
              readonly mediaType: string;
              readonly source: {
                readonly type: string;
                readonly field: string;
                readonly projectId: string;
                readonly sessionId: string;
              };
            };
          };
        };
      };
    };
    expect(responseRecord.record.response).toMatchObject({
      recordVersion: 2,
      text: {
        storage: "artifact",
        reference: {
          id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          byteCount: 256 * 1024 + 1,
          mediaType: "text/plain; charset=utf-8",
          source: {
            type: "model_response",
            field: "text",
            projectId,
            sessionId,
          },
        },
      },
    });
    expect(await artifactStore.read(responseRecord.record.response.text.reference.id)).toEqual(
      Buffer.from(answer),
    );
    expect(durabilityOrder).toEqual(["artifact-before-reference", "response-reference"]);
    expect(responseIndex).toBeGreaterThanOrEqual(0);
    expect(publicationIndex).toBeGreaterThan(responseIndex);
    expect(JSON.stringify(records)).not.toContain(answer.slice(0, 4_096));
    expect(completedAnswers).toEqual([answer]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession keeps an answer at the 256 KiB threshold inline", async () => {
  const answer = "i".repeat(256 * 1024);
  const store = createInMemorySessionStore<SessionRecord>();
  const model: ModelDriver = {
    async *stream() {
      yield { type: "text_delta", text: answer };
      yield { type: "finish", reason: "stop" };
    },
  };
  const dependencies = {
    model,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    contextProfile,
    [sessionDurableContext]: { nextSequence: 1, targetIdentity },
  };

  await expect(
    new AgentSession(dependencies).run({ text: "Return the inline answer." }),
  ).resolves.toEqual({ status: "completed", answer });
  const response = (await store.read()).find(
    (record) => record.schemaVersion === 3 && record.record.type === "model_response_completed",
  );
  expect(response).toMatchObject({
    record: { response: { text: answer } },
  });
});

test("AgentSession spills every non-empty response field when JSON escaping crosses 1 MiB", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-model-response-group-spill-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const sessionId = "model-response-group-spill";
  const projectId = "b".repeat(64);
  const text = "\u0000".repeat(200 * 1024);
  const reasoning = "\u0001".repeat(200 * 1024);
  await mkdir(workspaceRoot);
  const artifactStore = await createFileArtifactStore({ root: join(stateRoot, "artifacts") });
  const store = await createJsonlSessionStore<SessionRecord>({
    stateRoot,
    workspaceRoot,
    sessionId,
  });
  const model: ModelDriver = {
    async *stream() {
      yield {
        type: "reasoning_start",
        id: "provider-reasoning-0",
        artifactType: "provider_reasoning",
      } as const;
      yield { type: "reasoning_delta", id: "provider-reasoning-0", text: reasoning };
      yield { type: "reasoning_end", id: "provider-reasoning-0" } as const;
      yield { type: "text_delta", text };
      yield { type: "finish", reason: "stop" };
    },
  };
  const dependencies = {
    model,
    artifactStore,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    contextProfile,
    [sessionDurableContext]: {
      nextSequence: 1,
      targetIdentity,
      projectId,
      sessionId,
    },
  };
  const session = new AgentSession(dependencies);

  try {
    await expect(session.run({ text: "Return escaped fields." })).resolves.toEqual({
      status: "completed",
      answer: text,
    });
    const records = await store.read();
    const responseRecord = records.find(
      (record) => record.schemaVersion === 3 && record.record.type === "model_response_completed",
    ) as unknown as {
      readonly record: {
        readonly response: {
          readonly recordVersion: number;
          readonly text: { readonly storage: string; readonly reference: { readonly id: string } };
          readonly reasoning: {
            readonly storage: string;
            readonly reference: { readonly id: string };
          };
        };
      };
    };
    expect(responseRecord.record.response).toMatchObject({
      recordVersion: 2,
      text: { storage: "artifact" },
      reasoning: { storage: "artifact" },
    });
    await expect(
      artifactStore.read(responseRecord.record.response.text.reference.id),
    ).resolves.toEqual(Buffer.from(text));
    await expect(
      artifactStore.read(responseRecord.record.response.reasoning.reference.id),
    ).resolves.toEqual(Buffer.from(reasoning));
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession rejects text plus reasoning above the shared 64 MiB response envelope", async () => {
  const boundaryChunk = "x".repeat(64 * 1024 * 1024);
  const model: ModelDriver = {
    async *stream() {
      yield { type: "text_delta", text: boundaryChunk };
      yield {
        type: "reasoning_start",
        id: "provider-reasoning-0",
        artifactType: "provider_reasoning",
      } as const;
      yield { type: "reasoning_delta", id: "provider-reasoning-0", text: "y" };
      yield { type: "finish", reason: "stop" };
    },
  };
  const store: SessionStore = {
    async append() {},
    async read() {
      return [];
    },
  };

  const result = await new AgentSession({ model, store, contextProfile }).run({
    text: "Cross the shared response limit.",
  });
  expect(result.status).toBe("failed");
  if (result.status === "failed") {
    expect(result.error.code).toBe("model_response_too_large");
  }
});

test("AgentSession accepts separate text and reasoning at the shared 64 MiB boundary", async () => {
  const text = "t".repeat(32 * 1024 * 1024);
  const reasoning = "r".repeat(32 * 1024 * 1024);
  const model: ModelDriver = {
    async *stream() {
      yield {
        type: "reasoning_start",
        id: "provider-reasoning-0",
        artifactType: "provider_reasoning",
      } as const;
      yield { type: "reasoning_delta", id: "provider-reasoning-0", text: reasoning };
      yield { type: "reasoning_end", id: "provider-reasoning-0" } as const;
      yield { type: "text_delta", text };
      yield { type: "finish", reason: "stop" };
    },
  };
  const store: SessionStore = {
    async append() {},
    async read() {
      return [];
    },
  };

  const result = await new AgentSession({ model, store, contextProfile }).run({
    text: "Fill the shared response limit.",
  });
  expect(result.status).toBe("completed");
  if (result.status === "completed") {
    expect(Buffer.byteLength(result.answer, "utf8")).toBe(32 * 1024 * 1024);
  }
});

test("AgentSession charges physically deduplicated artifacts against logical response quota", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-model-response-quota-"));
  const artifactStore = await createFileArtifactStore({ root: join(testRoot, "artifacts") });
  const store = createInMemorySessionStore<SessionRecord>();
  let requestCount = 0;
  const model: ModelDriver = {
    async *stream() {
      requestCount += 1;
      yield { type: "text_delta", text: "same!" };
      yield { type: "finish", reason: "stop" };
    },
  };
  const dependencies = {
    model,
    artifactStore,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    contextProfile,
    [sessionDurableContext]: {
      nextSequence: 1,
      targetIdentity,
      projectId: "c".repeat(64),
      sessionId: "logical-quota",
    },
    [sessionDurableOutputLimits]: {
      maximumInlineFieldBytes: 4,
      maximumReferencedArtifactBytes: 8,
    },
  };
  const session = new AgentSession(dependencies);

  try {
    await expect(session.run({ text: "First." })).resolves.toEqual({
      status: "completed",
      answer: "same!",
    });
    const second = await session.run({ text: "Second." });
    expect(second).toMatchObject({
      status: "failed",
      error: { code: "model_response_artifact_quota_exceeded" },
    });
    expect(requestCount).toBe(2);
    const references = (await store.read()).flatMap((record) => {
      if (
        record.schemaVersion !== 3 ||
        record.record.type !== "model_response_completed" ||
        record.record.response.recordVersion !== 2 ||
        record.record.response.text.storage !== "artifact"
      ) {
        return [];
      }
      return [record.record.response.text.reference.id];
    });
    expect(references).toHaveLength(1);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle resolves artifact-backed responses across restart and branch replay", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-model-response-lifecycle-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const answer = "l".repeat(256 * 1024 + 1);
  const lifecycleProfile: ContextProfile = {
    ...contextProfile,
    contextWindowTokens: 1_000_000,
    compactAtTokens: 900_000,
    postCompactTargetTokens: 200_000,
    retainedTargetTokens: 20_000,
  };
  const observedMessages: ModelRequest["messages"][] = [];
  let requestCount = 0;
  await mkdir(workspaceRoot);
  const model: ModelDriver = {
    async *stream(request) {
      requestCount += 1;
      observedMessages.push(request.messages);
      yield {
        type: "text_delta",
        text: requestCount === 1 ? answer : "Child replayed the artifact-backed answer.",
      };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile: lifecycleProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "test" },
            contextProfile: lifecycleProfile,
          },
        ],
      };
    },
  };
  const options = { modelTargets, stateRoot, workspaceRoot };

  try {
    const lifecycle = createSessionLifecycle(options);
    const created = await lifecycle.create({ targetIdentity });
    const parent = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Create an artifact-backed answer." },
    });
    expect(parent.result).toEqual({ status: "completed", answer });

    const restarted = createSessionLifecycle(options);
    await expect(restarted.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      status: "settled",
      run: { status: "settled", result: { status: "completed", answer } },
    });
    const child = await restarted.branch({
      parentSessionId: created.sessionId,
      atSequence: parent.snapshot.lastSequence,
    });
    const childContinuation = await restarted.continue({
      sessionId: child.sessionId,
      input: { text: "Continue from the branch." },
    });
    expect(childContinuation.result).toEqual({
      status: "completed",
      answer: "Child replayed the artifact-backed answer.",
    });
    expect(observedMessages[1]).toContainEqual({
      role: "assistant",
      content: answer,
      toolCalls: [],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each(["missing", "corrupt"] as const)(
  "SessionLifecycle degrades inspection and blocks replay for a %s model-response artifact",
  async (damage) => {
    const testRoot = await mkdtemp(join(tmpdir(), `adam-agent-model-response-${damage}-`));
    const workspaceRoot = join(testRoot, "workspace");
    const stateRoot = join(testRoot, "state");
    const answer = "d".repeat(256 * 1024 + 1);
    const lifecycleProfile: ContextProfile = {
      ...contextProfile,
      contextWindowTokens: 1_000_000,
      compactAtTokens: 900_000,
      postCompactTargetTokens: 200_000,
      retainedTargetTokens: 20_000,
    };
    let requestCount = 0;
    await mkdir(workspaceRoot);
    const model: ModelDriver = {
      async *stream() {
        requestCount += 1;
        yield { type: "text_delta", text: answer };
        yield { type: "finish", reason: "stop" };
      },
    };
    const modelTargets: ModelTargets = {
      async resolve() {
        return { identity: targetIdentity, driver: model, contextProfile: lifecycleProfile };
      },
      async snapshot() {
        return {
          targets: [
            {
              identity: targetIdentity,
              readiness: { status: "available", credentialSource: "test" },
              contextProfile: lifecycleProfile,
            },
          ],
        };
      },
    };
    const options = { modelTargets, stateRoot, workspaceRoot };

    try {
      const lifecycle = createSessionLifecycle(options);
      const created = await lifecycle.create({ targetIdentity });
      const completed = await lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Persist replay authority." },
      });
      const child = await lifecycle.branch({
        parentSessionId: created.sessionId,
        atSequence: completed.snapshot.lastSequence,
      });
      const store = await openJsonlSessionStore<SessionRecord>({
        stateRoot,
        workspaceRoot,
        sessionId: created.sessionId,
      });
      const response = (await store.read()).find(
        (record) => record.schemaVersion === 3 && record.record.type === "model_response_completed",
      );
      if (
        response?.schemaVersion !== 3 ||
        response.record.type !== "model_response_completed" ||
        response.record.response.recordVersion !== 2 ||
        response.record.response.text.storage !== "artifact"
      ) {
        throw new Error("Expected an artifact-backed response fixture.");
      }
      const artifactId = response.record.response.text.reference.id;
      const artifactPath = join(stateRoot, "artifacts", artifactId.slice("sha256:".length));
      if (damage === "missing") {
        await rm(artifactPath);
      } else {
        await chmod(artifactPath, 0o600);
        await writeFile(artifactPath, "corrupt", "utf8");
      }

      const restarted = createSessionLifecycle(options);
      await expect(restarted.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
        status: "settled",
        degradation: {
          code:
            damage === "missing"
              ? "model_response_artifact_missing"
              : "model_response_artifact_corrupt",
          artifactId,
          field: "text",
        },
      });
      await expect(restarted.resume({ sessionId: created.sessionId })).resolves.toMatchObject({
        status: "rejected",
        error: { code: "session_replay_unavailable" },
      });
      await expect(restarted.inspect({ sessionId: child.sessionId })).resolves.toMatchObject({
        degradation: { artifactId },
      });
      await expect(restarted.resume({ sessionId: child.sessionId })).resolves.toMatchObject({
        status: "rejected",
        error: { code: "session_replay_unavailable" },
      });
      await expect(
        restarted.branch({
          parentSessionId: created.sessionId,
          atSequence: completed.snapshot.lastSequence,
        }),
      ).rejects.toMatchObject({ code: "session_invalid" });
      expect(requestCount).toBe(1);
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test("AgentSession fails closed when a model-response artifact cannot be written", async () => {
  const answer = "w".repeat(256 * 1024 + 1);
  const artifactStore: ArtifactStore = {
    async write() {
      throw new Error("injected artifact write failure");
    },
    async read() {
      return undefined;
    },
  };
  const store = createInMemorySessionStore<SessionRecord>();
  const model: ModelDriver = {
    async *stream() {
      yield { type: "text_delta", text: answer };
      yield { type: "finish", reason: "stop" };
    },
  };
  const dependencies = {
    model,
    artifactStore,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    contextProfile,
    [sessionDurableContext]: {
      nextSequence: 1,
      targetIdentity,
      projectId: "e".repeat(64),
      sessionId: "artifact-write-failure",
    },
  };

  await expect(
    new AgentSession(dependencies).run({ text: "Fail the artifact write." }),
  ).resolves.toMatchObject({
    status: "failed",
    error: { code: "session_persistence_failed" },
  });
  expect(
    (await store.read()).some(
      (record) => record.schemaVersion === 3 && record.record.type === "model_response_completed",
    ),
  ).toBe(false);
});

test("AgentSession permits an orphan only after artifact durability and before reference append", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-model-response-orphan-"));
  const answer = "o".repeat(256 * 1024 + 1);
  const realArtifactStore = await createFileArtifactStore({ root: join(testRoot, "artifacts") });
  let writtenArtifactId: string | undefined;
  const artifactStore: ArtifactStore = {
    async write(input) {
      const reference = await realArtifactStore.write(input);
      writtenArtifactId = reference.id;
      return reference;
    },
    read: (id, options) => realArtifactStore.read(id, options),
  };
  const innerStore = createInMemorySessionStore<SessionRecord>();
  const store: SessionStore<SessionRecord> = {
    async append(record) {
      if (record.schemaVersion === 3 && record.record.type === "model_response_completed") {
        throw new Error("injected crash before response reference");
      }
      await innerStore.append(record);
    },
    read: () => innerStore.read(),
  };
  const model: ModelDriver = {
    async *stream() {
      yield { type: "text_delta", text: answer };
      yield { type: "finish", reason: "stop" };
    },
  };
  const dependencies = {
    model,
    artifactStore,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    contextProfile,
    [sessionDurableContext]: {
      nextSequence: 1,
      targetIdentity,
      projectId: "f".repeat(64),
      sessionId: "artifact-orphan",
    },
  };

  try {
    await expect(
      new AgentSession(dependencies).run({ text: "Crash after artifact durability." }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "session_persistence_failed" },
    });
    expect(writtenArtifactId).toMatch(/^sha256:[0-9a-f]{64}$/u);
    await expect(realArtifactStore.read(writtenArtifactId as string)).resolves.toEqual(
      Buffer.from(answer),
    );
    expect(
      (await innerStore.read()).some(
        (record) => record.schemaVersion === 3 && record.record.type === "model_response_completed",
      ),
    ).toBe(false);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle completes bounded markers after a crash following the response reference", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-model-response-marker-recovery-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const answer = "m".repeat(256 * 1024 + 1);
  let requestCount = 0;
  await mkdir(workspaceRoot);
  const model: ModelDriver = {
    async *stream() {
      requestCount += 1;
      yield { type: "text_delta", text: answer };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile: roomyContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "test" },
            contextProfile: roomyContextProfile,
          },
        ],
      };
    },
  };
  const options = { modelTargets, stateRoot, workspaceRoot };

  try {
    const lifecycle = createSessionLifecycle(options);
    const created = await lifecycle.create({ targetIdentity });
    const jsonlStore = await openJsonlSessionStore<SessionRecord>({
      stateRoot,
      workspaceRoot,
      sessionId: created.sessionId,
    });
    let injectedCrash = false;
    const store: SessionStore<SessionRecord> = {
      async append(record) {
        if (
          !injectedCrash &&
          record.schemaVersion === 3 &&
          record.record.type === "model_response_published"
        ) {
          injectedCrash = true;
          throw new Error("injected crash after response reference");
        }
        await jsonlStore.append(record);
      },
      read: () => jsonlStore.read(),
    };
    const artifactStore = await createFileArtifactStore({ root: join(stateRoot, "artifacts") });
    const genesis = (await jsonlStore.read())[0];
    if (
      genesis?.schemaVersion !== 3 ||
      genesis.record.type !== "session_genesis" ||
      genesis.record.promptContext === undefined ||
      genesis.record.skillContext === undefined
    ) {
      throw new Error("Expected a v1 prompt context in the crash fixture genesis.");
    }
    const dependencies = {
      model,
      artifactStore,
      store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
      tools: createCodingToolRegistry({ stateRoot, workspaceRoot }),
      contextProfile: roomyContextProfile,
      [sessionDurableContext]: {
        nextSequence: 2,
        targetIdentity,
        projectId: created.projectId,
        promptContext: genesis.record.promptContext,
        skillContext: genesis.record.skillContext,
        repositoryWorkspaceRoot: workspaceRoot,
        sessionId: created.sessionId,
      },
    };
    await expect(
      new AgentSession(dependencies).run({ text: "Crash before publication." }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "session_persistence_failed" },
    });

    const restarted = createSessionLifecycle(options);
    await expect(restarted.resume({ sessionId: created.sessionId })).resolves.toMatchObject({
      status: "ready",
      snapshot: {
        status: "settled",
        run: { result: { status: "completed", answer } },
      },
    });
    const records = await jsonlStore.read();
    expect(records.slice(-2)).toMatchObject([
      { record: { type: "model_response_published" } },
      { record: { type: "run_settled", status: "completed" } },
    ]);
    expect(JSON.stringify(records)).not.toContain(answer.slice(0, 4_096));
    expect(requestCount).toBe(1);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle charges inherited branch artifacts before accepting a child response", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-model-response-lineage-quota-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  let requestCount = 0;
  await mkdir(workspaceRoot);
  const model: ModelDriver = {
    async *stream() {
      requestCount += 1;
      yield { type: "text_delta", text: "shared" };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile: roomyContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "test" },
            contextProfile: roomyContextProfile,
          },
        ],
      };
    },
  };
  const options = {
    modelTargets,
    stateRoot,
    workspaceRoot,
    [sessionDurableOutputLimits]: {
      maximumInlineFieldBytes: 4,
      maximumReferencedArtifactBytes: 10,
    },
  };

  try {
    const lifecycle = createSessionLifecycle(options);
    const created = await lifecycle.create({ targetIdentity });
    const parent = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Parent response." },
    });
    const child = await lifecycle.branch({
      parentSessionId: created.sessionId,
      atSequence: parent.snapshot.lastSequence,
    });
    await expect(
      lifecycle.continue({ sessionId: child.sessionId, input: { text: "Child response." } }),
    ).resolves.toMatchObject({
      result: {
        status: "failed",
        error: { code: "model_response_artifact_quota_exceeded" },
      },
    });
    expect(requestCount).toBe(2);
    const childStore = await openJsonlSessionStore<SessionRecord>({
      stateRoot,
      workspaceRoot,
      sessionId: child.sessionId,
    });
    expect(
      (await childStore.read()).some(
        (record) => record.schemaVersion === 3 && record.record.type === "model_response_completed",
      ),
    ).toBe(false);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession durably settles length output as incomplete without executing generated tools", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-model-output-limit-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const answer = "q".repeat(256 * 1024 + 1);
  let requestCount = 0;
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "secret.txt"), "must not be read", "utf8");
  const model: ModelDriver = {
    async *stream() {
      requestCount += 1;
      yield { type: "text_delta", text: answer };
      yield { type: "tool_call_start", id: "incomplete-read", name: "read_file" };
      yield { type: "tool_call_delta", id: "incomplete-read", json: '{"path":"secret.txt"}' };
      yield { type: "tool_call_end", id: "incomplete-read" };
      yield { type: "finish", reason: "length" };
    },
  };
  const artifactStore = await createFileArtifactStore({ root: join(stateRoot, "artifacts") });
  const store = await createJsonlSessionStore<SessionRecord>({
    stateRoot,
    workspaceRoot,
    sessionId: "output-limit",
  });
  const dependencies = {
    model,
    artifactStore,
    tools: createReadToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    contextProfile,
    [sessionDurableContext]: {
      nextSequence: 1,
      targetIdentity,
      projectId: "1".repeat(64),
      sessionId: "output-limit",
    },
  };
  const events: RuntimeEvent[] = [];
  const session = new AgentSession(dependencies);
  session.subscribe((event) => events.push(event));

  try {
    await expect(session.run({ text: "Reach the output limit." })).resolves.toEqual({
      status: "incomplete",
      reason: "output_limit",
      answer,
    });
    expect(requestCount).toBe(1);
    expect(events.some((event) => event.type.startsWith("tool_"))).toBe(false);
    const records = await store.read();
    expect(records).toContainEqual(
      expect.objectContaining({
        record: expect.objectContaining({
          type: "model_response_completed",
          response: expect.objectContaining({
            recordVersion: 2,
            finishReason: "length",
            text: expect.objectContaining({ storage: "artifact" }),
            toolCalls: [],
            toolIntents: [],
          }),
        }),
      }),
    );
    expect(records.at(-1)).toMatchObject({
      record: { type: "run_settled", status: "incomplete", reason: "output_limit" },
    });
    expect(JSON.stringify(records)).not.toContain(answer.slice(0, 4_096));
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle restores artifact-backed output-limit settlements as incomplete", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-output-limit-lifecycle-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const answer = "r".repeat(256 * 1024 + 1);
  let requestCount = 0;
  await mkdir(workspaceRoot);
  const model: ModelDriver = {
    async *stream() {
      requestCount += 1;
      yield { type: "text_delta", text: answer };
      yield { type: "finish", reason: "length" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile: roomyContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "test" },
            contextProfile: roomyContextProfile,
          },
        ],
      };
    },
  };
  const options = { modelTargets, stateRoot, workspaceRoot };

  try {
    const lifecycle = createSessionLifecycle(options);
    const created = await lifecycle.create({ targetIdentity });
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Reach the output limit durably." },
      }),
    ).resolves.toMatchObject({
      result: { status: "incomplete", reason: "output_limit", answer },
      snapshot: {
        status: "settled",
        run: {
          result: { status: "incomplete", reason: "output_limit", answer },
          lastCompletedResponse: { finishReason: "length" },
        },
      },
    });

    const restarted = createSessionLifecycle(options);
    await expect(restarted.resume({ sessionId: created.sessionId })).resolves.toMatchObject({
      status: "ready",
      snapshot: {
        status: "settled",
        run: { result: { status: "incomplete", reason: "output_limit", answer } },
      },
    });
    const store = await openJsonlSessionStore<SessionRecord>({
      stateRoot,
      workspaceRoot,
      sessionId: created.sessionId,
    });
    const records = await store.read();
    expect(records.at(-1)).toMatchObject({
      record: { type: "run_settled", status: "incomplete", reason: "output_limit" },
    });
    expect(JSON.stringify(records)).not.toContain(answer.slice(0, 4_096));
    expect(requestCount).toBe(1);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

largeOutputTest(
  "SessionLifecycle replays and branches an approximately 46.875 MiB response",
  async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-large-model-response-"));
    const workspaceRoot = join(testRoot, "workspace");
    const stateRoot = join(testRoot, "state");
    const answerBytes = 49_152_000;
    const answer = "L".repeat(answerBytes);
    let requestCount = 0;
    await mkdir(workspaceRoot);
    const model: ModelDriver = {
      async *stream() {
        requestCount += 1;
        yield { type: "text_delta", text: answer };
        yield { type: "finish", reason: "stop" };
      },
    };
    const modelTargets: ModelTargets = {
      async resolve() {
        return { identity: targetIdentity, driver: model, contextProfile };
      },
      async snapshot() {
        return {
          targets: [
            {
              identity: targetIdentity,
              readiness: { status: "available", credentialSource: "test" },
              contextProfile,
            },
          ],
        };
      },
    };
    const options = { modelTargets, stateRoot, workspaceRoot };

    try {
      const lifecycle = createSessionLifecycle(options);
      const created = await lifecycle.create({ targetIdentity });
      const completed = await lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Produce the synthetic large response." },
      });
      expect(completed.result.status).toBe("completed");
      if (completed.result.status !== "completed") {
        throw new Error("Expected the large synthetic response to complete.");
      }
      expect(completed.result.answer).toBe(answer);

      const restarted = createSessionLifecycle(options);
      const inspected = await restarted.inspect({ sessionId: created.sessionId });
      if (inspected.schemaVersion !== 3) {
        throw new Error("Expected a current session snapshot.");
      }
      expect(inspected.degradation).toBeUndefined();
      expect(inspected.run?.result).toMatchObject({ status: "completed" });
      if (inspected.run?.result?.status !== "completed") {
        throw new Error("Expected inspection to materialize the large response.");
      }
      expect(inspected.run.result.answer).toBe(answer);
      const resumed = await restarted.resume({ sessionId: created.sessionId });
      expect(resumed).toMatchObject({ status: "ready", snapshot: { status: "settled" } });
      if (resumed.status !== "ready" || resumed.snapshot.schemaVersion !== 3) {
        throw new Error("Expected resume-capable current replay.");
      }
      expect(resumed.snapshot.degradation).toBeUndefined();
      const child = await restarted.branch({
        parentSessionId: created.sessionId,
        atSequence: completed.snapshot.lastSequence,
      });
      await expect(restarted.inspect({ sessionId: child.sessionId })).resolves.toMatchObject({
        status: "idle",
        lineage: { parentSessionId: created.sessionId },
      });

      const store = await openJsonlSessionStore<SessionRecord>({
        stateRoot,
        workspaceRoot,
        sessionId: created.sessionId,
      });
      const response = (await store.read()).find(
        (record) => record.schemaVersion === 3 && record.record.type === "model_response_completed",
      );
      if (
        response?.schemaVersion !== 3 ||
        response.record.type !== "model_response_completed" ||
        response.record.response.recordVersion !== 2 ||
        response.record.response.text.storage !== "artifact"
      ) {
        throw new Error("Expected a durable large-response artifact reference.");
      }
      expect(response.record.response.text.reference.byteCount).toBe(answerBytes);
      expect(requestCount).toBe(1);
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test("AgentSession clamps the v2 ordinary output budget at the DeepSeek context boundary", async () => {
  const observedBudgets: number[] = [];
  const observedInputProjections: number[] = [];

  for (const contentBytes of [2_447_555, 2_447_559]) {
    const model: ModelDriver = {
      async *stream(request) {
        observedInputProjections.push(
          Math.ceil(Buffer.byteLength(JSON.stringify(request.messages), "utf8") / 4),
        );
        if (request.maximumOutputTokens !== undefined) {
          observedBudgets.push(request.maximumOutputTokens);
        }
        yield { type: "text_delta", text: "Boundary observed." };
        yield { type: "finish", reason: "stop" };
      },
    };
    const dependencies = {
      model,
      store: createInMemorySessionStore(),
      [sessionDurableContext]: {
        nextSequence: 1,
        targetIdentity,
        initialMessages: [{ role: "system" as const, content: "x".repeat(contentBytes) }],
      },
      contextProfile: preparedDirectDeepSeekV2ContextProfile,
    };

    await new AgentSession(dependencies).run({ text: "" });
  }

  expect(observedInputProjections).toEqual([611_904, 611_905]);
  expect(observedBudgets).toEqual([384_000, 383_999]);
});

test("Direct DeepSeek payload receives the exact small, boundary, and summary budgets", async () => {
  const requests: Array<{ readonly maximumOutputTokens: number; readonly isSummary: boolean }> = [];
  const summary = JSON.stringify({
    schemaVersion: 1,
    objective: "Preserve the active task.",
    constraints: [],
    progress: [],
    unresolvedQuestions: [],
    failures: [],
    remainingVerification: [],
    nextSafeAction: "Continue with the compacted projection.",
  });
  const driver = new OpenAICompatibleModelDriver({
    profile: "deepseek",
    apiKey: "test-deepseek-key",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    maximumOutputTokens: 384_000,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        readonly max_tokens: number;
        readonly messages: readonly { readonly content?: unknown }[];
      };
      const isSummary = body.messages.some(
        (message) =>
          typeof message.content === "string" && message.content.startsWith("Compact this"),
      );
      requests.push({ maximumOutputTokens: body.max_tokens, isSummary });
      return new Response(deepSeekTextStream(isSummary ? summary : "Budget observed."), {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  });

  await new AgentSession({
    model: driver,
    store: createInMemorySessionStore(),
    contextProfile: preparedDirectDeepSeekV2ContextProfile,
  }).run({ text: "Use the small-context maximum." });

  for (const contentBytes of [2_447_555, 2_447_559]) {
    const dependencies = {
      model: driver,
      store: createInMemorySessionStore(),
      contextProfile: preparedDirectDeepSeekV2ContextProfile,
      [sessionDurableContext]: {
        nextSequence: 1,
        targetIdentity: { ...targetIdentity, profileVersion: 2 },
        initialMessages: [{ role: "system", content: "x".repeat(contentBytes) }],
      },
    };
    await new AgentSession(dependencies).run({ text: "" });
  }

  const compactionProfile: ContextProfile = {
    ...preparedDirectDeepSeekV2ContextProfile,
    compactAtTokens: 500,
    postCompactTargetTokens: 400,
    retainedTargetTokens: 0,
  };
  const compactionDependencies = {
    model: driver,
    store: createInMemorySessionStore<SessionRecord>() as unknown as ConstructorParameters<
      typeof AgentSession
    >[0]["store"],
    contextProfile: compactionProfile,
    [sessionDurableContext]: {
      nextSequence: 1,
      targetIdentity: { ...targetIdentity, profileVersion: 2 },
      initialMessages: [{ role: "system", content: "large active context ".repeat(120) }],
    },
  };
  await new AgentSession(compactionDependencies).run({ text: "Finish after compaction." });

  expect(requests.slice(0, 3)).toEqual([
    { maximumOutputTokens: 384_000, isSummary: false },
    { maximumOutputTokens: 384_000, isSummary: false },
    { maximumOutputTokens: 383_999, isSummary: false },
  ]);
  expect(requests.filter((request) => request.isSummary)).toEqual([
    { maximumOutputTokens: 32_768, isSummary: true },
  ]);
});

test("AgentSession keeps the v2 compaction summary budget separate from ordinary output", async () => {
  const summary = JSON.stringify({
    schemaVersion: 1,
    objective: "Preserve the active task.",
    constraints: [],
    progress: [],
    unresolvedQuestions: [],
    failures: [],
    remainingVerification: [],
    nextSafeAction: "Continue with the compacted projection.",
  });
  const v2Profile: ContextProfile = {
    version: 2,
    contextWindowTokens: 1_000_000,
    maximumOutputTokens: 384_000,
    ordinaryOutputReserveTokens: 4_096,
    compactionSummaryMaximumOutputTokens: 32_768,
    compactAtTokens: 500,
    postCompactTargetTokens: 400,
    retainedTargetTokens: 0,
    estimatorVersion: 1,
  };
  const observedBudgets: Array<number | undefined> = [];
  const thinkingPolicy = {
    schemaVersion: 1 as const,
    requestedLevelId: "max",
    effectiveLevelId: "max",
    capability: {
      id: "test:deepseek-thinking",
      version: 1 as const,
      digest: `sha256:${"1".repeat(64)}` as const,
    },
    mapping: {
      requestPath: "provider_options.deepseek" as const,
      thinkingType: "enabled" as const,
      reasoningEffort: "max" as const,
    },
    reasoningArtifact: "provider_reasoning" as const,
  };
  const observedThinkingPolicies: Array<ModelRequest["thinkingPolicy"]> = [];
  const model: ModelDriver = {
    async *stream(request) {
      observedBudgets.push(request.maximumOutputTokens);
      observedThinkingPolicies.push(request.thinkingPolicy);
      if (
        request.messages.some(
          (message) => message.role === "system" && message.content.startsWith("Compact this"),
        )
      ) {
        yield { type: "text_delta", text: summary };
        yield { type: "finish", reason: "stop" };
        return;
      }
      yield { type: "text_delta", text: "Separate budgets observed." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const store = createInMemorySessionStore<SessionRecord>();
  const dependencies = {
    model,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    [sessionDurableContext]: {
      nextSequence: 1,
      targetIdentity: { ...targetIdentity, profileVersion: 2 },
      thinkingPolicy,
      initialMessages: [{ role: "system" as const, content: "large active context ".repeat(120) }],
    },
    contextProfile: v2Profile,
  };

  await expect(new AgentSession(dependencies).run({ text: "Finish the task." })).resolves.toEqual({
    status: "completed",
    answer: "Separate budgets observed.",
  });
  expect(observedBudgets).toEqual([32_768, 384_000]);
  expect(observedThinkingPolicies).toEqual([undefined, thinkingPolicy]);
});

test("AgentSession fails closed before sending a non-positive output budget", async () => {
  let modelCalls = 0;
  const model: ModelDriver = {
    async *stream() {
      modelCalls += 1;
      yield { type: "text_delta", text: "This request must not be sent." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const noRoomProfile: ContextProfile = {
    version: 2,
    contextWindowTokens: 100,
    maximumOutputTokens: 80,
    ordinaryOutputReserveTokens: 10,
    compactionSummaryMaximumOutputTokens: 20,
    compactAtTokens: 90,
    postCompactTargetTokens: 50,
    retainedTargetTokens: 10,
    estimatorVersion: 1,
  };
  const dependencies = {
    model,
    store: createInMemorySessionStore(),
    contextProfile: noRoomProfile,
  };

  await expect(new AgentSession(dependencies).run({ text: "x".repeat(330) })).resolves.toEqual({
    status: "failed",
    error: {
      code: "context_window_unrecoverable",
      message: "The active context leaves no safe output capacity for this model request.",
    },
  });
  expect(modelCalls).toBe(0);
});

test("AgentSession uses the latest provider input sample for the next v2 output budget", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-context-output-sample-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "# Adam\n", "utf8");
  const observedBudgets: Array<number | undefined> = [];
  let call = 0;
  const model: ModelDriver = {
    async *stream(request) {
      observedBudgets.push(request.maximumOutputTokens);
      call += 1;
      if (call === 1) {
        yield { type: "usage", inputTokens: 611_832, outputTokens: 1 };
        yield { type: "tool_call_start", id: "read-budget", name: "read_file" };
        yield {
          type: "tool_call_delta",
          id: "read-budget",
          json: '{"path":"README.md"}',
        };
        yield { type: "tool_call_end", id: "read-budget" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "Provider sample preserved." };
      yield { type: "usage", inputTokens: 611_905, outputTokens: 2 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const dependencies = {
    model,
    store: createInMemorySessionStore(),
    tools: createReadToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    contextProfile: preparedDirectDeepSeekV2ContextProfile,
  };

  try {
    await expect(new AgentSession(dependencies).run({ text: "Read README.md." })).resolves.toEqual({
      status: "completed",
      answer: "Provider sample preserved.",
    });
    expect(observedBudgets).toEqual([384_000, 383_999]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession applies the prepared DeepSeek v2 compaction thresholds", async () => {
  const olderAssistant = {
    role: "assistant" as const,
    content: "o".repeat(8_000),
    toolCalls: [],
  };
  const recentUser = { role: "user" as const, content: "r".repeat(75_000) };
  const currentUser = { role: "user" as const, content: "" };
  const emptySystem = { role: "system" as const, content: "" };
  const fixedBytes = Buffer.byteLength(
    JSON.stringify([emptySystem, olderAssistant, recentUser, currentUser]),
    "utf8",
  );
  const initialMessages = [
    { ...emptySystem, content: "x".repeat(3_600_000 - fixedBytes) },
    olderAssistant,
    recentUser,
  ];
  expect(
    Math.ceil(Buffer.byteLength(JSON.stringify([...initialMessages, currentUser]), "utf8") / 4),
  ).toBe(900_000);

  const summary = JSON.stringify({
    schemaVersion: 1,
    objective: "Preserve the exact v2 threshold fixture.",
    constraints: [],
    progress: [],
    unresolvedQuestions: [],
    failures: [],
    remainingVerification: [],
    nextSafeAction: "Continue after compaction.",
  });
  const requests: ModelRequest[] = [];
  const model: ModelDriver = {
    async *stream(request) {
      requests.push(request);
      if (
        request.messages.some(
          (message) => message.role === "system" && message.content.startsWith("Compact this"),
        )
      ) {
        yield { type: "text_delta", text: summary };
        yield { type: "finish", reason: "stop" };
        return;
      }
      yield { type: "text_delta", text: "Prepared thresholds observed." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const store = createInMemorySessionStore<SessionRecord>();
  const dependencies = {
    model,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    [sessionDurableContext]: {
      nextSequence: 1,
      targetIdentity: { ...targetIdentity, profileVersion: 2 },
      initialMessages,
    },
    contextProfile: preparedDirectDeepSeekV2ContextProfile,
  };

  await expect(new AgentSession(dependencies).run({ text: "" })).resolves.toEqual({
    status: "completed",
    answer: "Prepared thresholds observed.",
  });
  expect(preparedDirectDeepSeekV2ContextProfile).toMatchObject({
    compactAtTokens: 900_000,
    postCompactTargetTokens: 200_000,
    retainedTargetTokens: 20_000,
  });
  expect(requests.map((request) => request.maximumOutputTokens)).toEqual([32_768, 384_000]);
  const ordinaryRequest = requests[1];
  expect(ordinaryRequest).toBeDefined();
  expect(
    Math.ceil(Buffer.byteLength(JSON.stringify(ordinaryRequest?.messages), "utf8") / 4),
  ).toBeLessThan(200_000);
  expect(ordinaryRequest?.messages).toContainEqual(recentUser);
  expect(ordinaryRequest?.messages).not.toContainEqual(olderAssistant);
});

test("the aggregate run token limit does not replace the v2 per-call output budget", async () => {
  const observedBudgets: Array<number | undefined> = [];
  const model: ModelDriver = {
    async *stream(request) {
      observedBudgets.push(request.maximumOutputTokens);
      yield { type: "text_delta", text: "The budgets remain distinct." };
      yield { type: "usage", inputTokens: 2, outputTokens: 2 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const dependencies = {
    model,
    store: createInMemorySessionStore(),
    contextProfile: preparedDirectDeepSeekV2ContextProfile,
  };

  await expect(
    new AgentSession(dependencies).run(
      { text: "Keep the request and run budgets separate." },
      { limits: { maxTokens: 10 } },
    ),
  ).resolves.toEqual({ status: "completed", answer: "The budgets remain distinct." });
  expect(observedBudgets).toEqual([384_000]);
});

test("AgentSession durably compacts before the next ordinary provider call", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-context-compaction-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, "context.txt"),
    "durable context detail ".repeat(160),
    "utf8",
  );

  const store = createInMemorySessionStore<SessionRecord>();
  await store.append({
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      sessionId: "10000000-0000-4000-8000-000000000001",
      projectId: `sha256:${"0".repeat(64)}`,
      targetIdentity,
    },
  });

  const requests: Array<{
    readonly messages: ModelRequest["messages"];
    readonly tools: ModelRequest["tools"];
    readonly records: readonly SessionRecord[];
  }> = [];
  let ordinaryCall = 0;
  const summary = JSON.stringify({
    schemaVersion: 1,
    objective: "Use the repository context and finish the requested task.",
    constraints: ["Keep durable history authoritative."],
    progress: ["The context file was read."],
    unresolvedQuestions: [],
    failures: [],
    remainingVerification: ["Return the final answer."],
    nextSafeAction: "Continue with the compacted context.",
  });
  const model: ModelDriver = {
    async *stream(request) {
      requests.push({
        messages: request.messages,
        tools: request.tools,
        records: await store.read(),
      });
      if (request.tools.length === 0) {
        yield { type: "text_delta", text: summary };
        yield { type: "usage", inputTokens: 560, outputTokens: 40 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      ordinaryCall += 1;
      if (ordinaryCall === 1) {
        yield { type: "usage", inputTokens: 20, outputTokens: 8 };
        yield { type: "tool_call_start", id: "read-context", name: "read_file" };
        yield {
          type: "tool_call_delta",
          id: "read-context",
          json: '{"path":"context.txt"}',
        };
        yield { type: "tool_call_end", id: "read-context" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      expect(
        request.messages.some(
          (message) => message.role === "developer" && message.content.includes("<context-summary"),
        ),
      ).toBe(true);
      yield { type: "text_delta", text: "Compaction preserved the task." };
      yield { type: "usage", inputTokens: 90, outputTokens: 12 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const dependencies = {
    model,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    tools: createReadToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    [sessionDurableContext]: {
      nextSequence: 2,
      targetIdentity,
    },
    contextProfile: contextProfile,
  };
  const session = new AgentSession(dependencies);
  const events: RuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));

  try {
    const result = await session.run(
      { text: "Read context.txt and finish the task." },
      { limits: { maxTurns: 2 } },
    );
    expect({ result, records: await store.read() }).toMatchObject({
      result: {
        status: "completed",
        answer: "Compaction preserved the task.",
      },
    });

    expect(requests).toHaveLength(3);
    expect(requests[1]?.tools).toEqual([]);
    expect(requests[1]?.records.at(-1)).toMatchObject({
      record: { type: "context_compaction_started", attemptNumber: 1 },
    });
    const secondOrdinaryRecords = requests[2]?.records ?? [];
    const committedIndex = secondOrdinaryRecords.findIndex(
      (record) =>
        record.schemaVersion === 3 && record.record.type === "context_compaction_committed",
    );
    const nextProviderIndex = secondOrdinaryRecords.findIndex(
      (record, index) =>
        index > committedIndex &&
        record.schemaVersion === 3 &&
        record.record.type === "provider_attempt_started",
    );
    expect({ committedIndex, nextProviderIndex }).toEqual({
      committedIndex: expect.any(Number),
      nextProviderIndex: expect.any(Number),
    });
    expect(committedIndex).toBeGreaterThanOrEqual(0);
    expect(nextProviderIndex).toBeGreaterThan(committedIndex);
    expect(events.filter((event) => event.type.startsWith("context_compaction_"))).toEqual([
      expect.objectContaining({ type: "context_compaction_started", attemptNumber: 1 }),
      expect.objectContaining({ type: "context_compaction_committed", windowNumber: 1 }),
    ]);
    expect(events.filter((event) => event.type === "context_usage")).toEqual([
      {
        type: "context_usage",
        ordinary: {
          inputTokens: 20,
          outputTokens: 8,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          cacheMissInputTokens: 0,
          unknownCalls: 0,
        },
        compaction: {
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          cacheMissInputTokens: 0,
          unknownCalls: 0,
        },
        active: expect.objectContaining({ source: "provider_reported", tokens: 20 }),
      },
      {
        type: "context_usage",
        ordinary: {
          inputTokens: 20,
          outputTokens: 8,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          cacheMissInputTokens: 0,
          unknownCalls: 0,
        },
        compaction: {
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          cacheMissInputTokens: 0,
          unknownCalls: 0,
        },
        active: expect.objectContaining({ source: "estimated", tokens: expect.any(Number) }),
      },
      {
        type: "context_usage",
        ordinary: {
          inputTokens: 20,
          outputTokens: 8,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          cacheMissInputTokens: 0,
          unknownCalls: 0,
        },
        compaction: {
          inputTokens: 560,
          outputTokens: 40,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          cacheMissInputTokens: 0,
          unknownCalls: 0,
        },
        active: expect.objectContaining({ source: "estimated", tokens: expect.any(Number) }),
      },
      {
        type: "context_usage",
        ordinary: {
          inputTokens: 110,
          outputTokens: 20,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          cacheMissInputTokens: 0,
          unknownCalls: 0,
        },
        compaction: {
          inputTokens: 560,
          outputTokens: 40,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          cacheMissInputTokens: 0,
          unknownCalls: 0,
        },
        active: expect.objectContaining({ source: "provider_reported", tokens: 90 }),
      },
    ]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession fails before the model when protected compaction input cannot fit", async () => {
  const store = createInMemorySessionStore<SessionRecord>();
  await store.append({
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      sessionId: "11000000-0000-4000-8000-000000000011",
      projectId: `sha256:${"e".repeat(64)}`,
      targetIdentity,
    },
  });
  const tinyProfile: ContextProfile = {
    version: 1,
    contextWindowTokens: 200,
    maximumOutputTokens: 50,
    compactAtTokens: 120,
    postCompactTargetTokens: 80,
    retainedTargetTokens: 0,
    estimatorVersion: 1,
  };
  let modelCalls = 0;
  const model: ModelDriver = {
    async *stream() {
      modelCalls += 1;
      yield { type: "finish", reason: "stop" };
    },
  };
  const dependencies = {
    model,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    [sessionDurableContext]: { nextSequence: 2, targetIdentity },
    contextProfile: tinyProfile,
  };
  const session = new AgentSession(dependencies);

  await expect(
    session.run({ text: `Preserve this required constraint: ${"x".repeat(4_000)}` }),
  ).resolves.toEqual({
    status: "failed",
    error: {
      code: "context_compaction_input_unrecoverable",
      message: "The protected context cannot fit in one compaction request.",
    },
  });
  expect(modelCalls).toBe(0);
  expect(
    (await store.read()).filter(
      (record) => record.schemaVersion === 3 && record.record.type === "context_compaction_failed",
    ),
  ).toMatchObject([{ record: { attemptNumber: 1, reason: "input_unrecoverable" } }]);
});

test("SessionLifecycle keeps a pre-provider compaction failure inspectable", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-context-pre-provider-failure-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  const tinyProfile: ContextProfile = {
    version: 1,
    contextWindowTokens: 500,
    maximumOutputTokens: 100,
    compactAtTokens: 100,
    postCompactTargetTokens: 80,
    retainedTargetTokens: 0,
    estimatorVersion: 1,
  };
  let modelCalls = 0;
  const model: ModelDriver = {
    async *stream() {
      modelCalls += 1;
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile: tinyProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "test" },
            contextProfile: tinyProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: `Preserve this required constraint: ${"x".repeat(4_000)}` },
    });
    expect(continued).toMatchObject({
      result: { status: "failed", error: { code: "context_compaction_input_unrecoverable" } },
      snapshot: {
        status: "settled",
        context: { lastAttempt: { status: "failed", reason: "input_unrecoverable" } },
      },
    });
    await expect(
      createSessionLifecycle({ stateRoot, workspaceRoot }).inspect({
        sessionId: created.sessionId,
      }),
    ).resolves.toEqual(continued.snapshot);
    expect(modelCalls).toBe(0);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession continues without a token limit while compaction usage stays unknown", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-context-unknown-usage-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const store = createInMemorySessionStore<SessionRecord>();
  await store.append({
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      sessionId: "12000000-0000-4000-8000-000000000012",
      projectId: `sha256:${"f".repeat(64)}`,
      targetIdentity,
    },
  });
  let compactionCall = 0;
  let ordinaryCall = 0;
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        compactionCall += 1;
        yield {
          type: "text_delta",
          text: JSON.stringify({
            schemaVersion: 1,
            objective: "Continue with unknown compaction usage.",
            constraints: [],
            progress: [],
            unresolvedQuestions: [],
            failures: [],
            remainingVerification: [],
            nextSafeAction: "Make the ordinary call.",
          }),
        };
        yield { type: "finish", reason: "stop" };
        return;
      }
      ordinaryCall += 1;
      yield { type: "text_delta", text: "Unknown usage remained explicit." };
      yield { type: "usage", inputTokens: 80, outputTokens: 10 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const dependencies = {
    model,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    tools: createReadToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    [sessionDurableContext]: { nextSequence: 2, targetIdentity },
    contextProfile: contextProfile,
  };
  const session = new AgentSession(dependencies);
  const events: RuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));

  try {
    await expect(
      session.run({ text: `Preserve this long request. ${"context ".repeat(400)}` }),
    ).resolves.toEqual({
      status: "completed",
      answer: "Unknown usage remained explicit.",
    });
    expect({ compactionCall, ordinaryCall }).toEqual({ compactionCall: 1, ordinaryCall: 1 });
    expect(events.filter((event) => event.type === "context_usage")).toContainEqual(
      expect.objectContaining({
        compaction: expect.objectContaining({ unknownCalls: 1 }),
        active: {
          source: "estimated",
          tokens: expect.any(Number),
          throughSequence: expect.any(Number),
        },
      }),
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession fails closed before resumed work when prior compaction usage is unknown under maxTokens", async () => {
  const store = createInMemorySessionStore<SessionRecord>();
  await store.append({
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      sessionId: "13000000-0000-4000-8000-000000000013",
      projectId: `sha256:${"e".repeat(64)}`,
      targetIdentity,
    },
  });
  let modelCalls = 0;
  const model: ModelDriver = {
    async *stream() {
      modelCalls += 1;
      yield { type: "finish", reason: "stop" };
    },
  };
  const dependencies = {
    model,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    [sessionDurableContext]: {
      nextSequence: 2,
      targetIdentity,
      resume: {
        runId: "14000000-0000-4000-8000-000000000014",
        messages: [{ role: "user", content: "Resume only with trustworthy accounting." }],
        nextTurn: 1,
        nextAttempt: 2,
        reportedTokens: 0,
        compactionUsageUnknown: true,
        toolResults: [],
        pendingToolCalls: [],
      },
    },
    contextProfile: contextProfile,
  };
  const session = new AgentSession(dependencies);

  await expect(
    session.run(
      { text: "Resume only with trustworthy accounting." },
      { limits: { maxTokens: 1_000 } },
    ),
  ).resolves.toEqual({
    status: "failed",
    error: {
      code: "token_usage_missing",
      message: "The provider did not report token usage for an active token limit.",
    },
  });
  expect(modelCalls).toBe(0);
});

test("AgentSession never uses a compacted projection when checkpoint persistence fails", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-context-persistence-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "context.txt"), "large result ".repeat(240), "utf8");

  const durableStore = createInMemorySessionStore<SessionRecord>();
  await durableStore.append({
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      sessionId: "20000000-0000-4000-8000-000000000002",
      projectId: `sha256:${"1".repeat(64)}`,
      targetIdentity,
    },
  });
  const failingStore: SessionStore<SessionRecord> = {
    async append(record) {
      if (record.schemaVersion === 3 && record.record.type === "context_compaction_committed") {
        throw new Error("checkpoint append failed");
      }
      await durableStore.append(record);
    },
    read: () => durableStore.read(),
  };
  const requests: ModelRequest[] = [];
  let ordinaryCall = 0;
  const model: ModelDriver = {
    async *stream(request) {
      requests.push(request);
      if (request.tools.length === 0) {
        yield {
          type: "text_delta",
          text: JSON.stringify({
            schemaVersion: 1,
            objective: "Preserve the task.",
            constraints: [],
            progress: ["Read the context file."],
            unresolvedQuestions: [],
            failures: [],
            remainingVerification: [],
            nextSafeAction: "Continue.",
          }),
        };
        yield { type: "usage", inputTokens: 520, outputTokens: 20 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      ordinaryCall += 1;
      if (ordinaryCall > 1) {
        throw new Error("An ordinary call must not run after the checkpoint append failure.");
      }
      yield { type: "usage", inputTokens: 20, outputTokens: 8 };
      yield { type: "tool_call_start", id: "read-before-failure", name: "read_file" };
      yield {
        type: "tool_call_delta",
        id: "read-before-failure",
        json: '{"path":"context.txt"}',
      };
      yield { type: "tool_call_end", id: "read-before-failure" };
      yield { type: "finish", reason: "tool_calls" };
    },
  };
  const dependencies = {
    model,
    store: failingStore as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    tools: createReadToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    [sessionDurableContext]: { nextSequence: 2, targetIdentity },
    contextProfile: contextProfile,
  };
  const session = new AgentSession(dependencies);
  const events: RuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));

  try {
    await expect(session.run({ text: "Read context.txt before compaction." })).resolves.toEqual({
      status: "failed",
      error: {
        code: "session_persistence_failed",
        message: "The session event could not be persisted.",
      },
    });
    expect(requests).toHaveLength(2);
    expect(events.filter((event) => event.type.startsWith("context_compaction_"))).toEqual([
      expect.objectContaining({ type: "context_compaction_started" }),
    ]);
    expect(
      (await durableStore.read()).some(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "context_compaction_committed",
      ),
    ).toBe(false);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession charges compaction usage before another ordinary provider call", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-context-budget-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "context.txt"), "budgeted context ".repeat(220), "utf8");

  const store = createInMemorySessionStore<SessionRecord>();
  await store.append({
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      sessionId: "30000000-0000-4000-8000-000000000003",
      projectId: `sha256:${"2".repeat(64)}`,
      targetIdentity,
    },
  });
  const requests: ModelRequest[] = [];
  const model: ModelDriver = {
    async *stream(request) {
      requests.push(request);
      if (request.tools.length === 0) {
        yield {
          type: "text_delta",
          text: JSON.stringify({
            schemaVersion: 1,
            objective: "Respect the run budget.",
            constraints: [],
            progress: [],
            unresolvedQuestions: [],
            failures: [],
            remainingVerification: [],
            nextSafeAction: "Stop before another ordinary call.",
          }),
        };
        yield {
          type: "usage",
          inputTokens: 70,
          outputTokens: 20,
          reasoningTokens: 10,
          cachedInputTokens: 25,
          cacheMissInputTokens: 45,
        };
        yield { type: "finish", reason: "stop" };
        return;
      }
      if (requests.filter((candidate) => candidate.tools.length > 0).length > 1) {
        throw new Error("The token budget must stop before another ordinary call.");
      }
      yield {
        type: "usage",
        inputTokens: 20,
        outputTokens: 8,
        reasoningTokens: 3,
        cachedInputTokens: 5,
        cacheMissInputTokens: 15,
      };
      yield { type: "tool_call_start", id: "read-budget", name: "read_file" };
      yield { type: "tool_call_delta", id: "read-budget", json: '{"path":"context.txt"}' };
      yield { type: "tool_call_end", id: "read-budget" };
      yield { type: "finish", reason: "tool_calls" };
    },
  };
  const dependencies = {
    model,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    tools: createReadToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    [sessionDurableContext]: { nextSequence: 2, targetIdentity },
    contextProfile: contextProfile,
  };
  const session = new AgentSession(dependencies);

  try {
    await expect(
      session.run(
        { text: "Read context.txt without exceeding the token budget." },
        { limits: { maxTokens: 100, maxTurns: 2 } },
      ),
    ).resolves.toEqual({
      status: "failed",
      error: {
        code: "token_limit_exceeded",
        message: "The run reached its provider-reported token limit.",
      },
    });
    expect(requests).toHaveLength(2);
    expect(
      (await store.read()).find(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "context_compaction_committed",
      ),
    ).toMatchObject({
      record: {
        usage: {
          inputTokens: 70,
          outputTokens: 20,
          reasoningTokens: 10,
          cachedInputTokens: 25,
          cacheMissInputTokens: 45,
        },
      },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession fits bulky tool output while preserving canonical write evidence", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-context-evidence-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, "context.txt"),
    `${"bulky evidence line\n".repeat(500)}VERY_LATE_CONTEXT_TAIL`,
    "utf8",
  );

  const store = createInMemorySessionStore<SessionRecord>();
  await store.append({
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      sessionId: "40000000-0000-4000-8000-000000000004",
      projectId: `sha256:${"3".repeat(64)}`,
      targetIdentity,
    },
  });
  let ordinaryCall = 0;
  let fittedSummaryInput = "";
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        const summaryInput = request.messages.at(-1);
        fittedSummaryInput =
          summaryInput?.role === "user" && typeof summaryInput.content === "string"
            ? summaryInput.content
            : "";
        yield {
          type: "text_delta",
          text: JSON.stringify({
            schemaVersion: 1,
            objective: "Continue the coding task.",
            constraints: [],
            progress: ["Some repository work completed."],
            unresolvedQuestions: [],
            failures: [],
            remainingVerification: [],
            nextSafeAction: "Inspect canonical evidence and continue.",
          }),
        };
        yield { type: "usage", inputTokens: 600, outputTokens: 30 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      ordinaryCall += 1;
      if (ordinaryCall === 1) {
        yield { type: "usage", inputTokens: 30, outputTokens: 12 };
        yield { type: "tool_call_start", id: "read-evidence", name: "read_file" };
        yield {
          type: "tool_call_delta",
          id: "read-evidence",
          json: '{"path":"context.txt"}',
        };
        yield { type: "tool_call_end", id: "read-evidence" };
        yield { type: "tool_call_start", id: "write-evidence", name: "write_file" };
        yield {
          type: "tool_call_delta",
          id: "write-evidence",
          json: '{"path":"output.txt","content":"preserved output\\n"}',
        };
        yield { type: "tool_call_end", id: "write-evidence" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      const summaryMessage = request.messages.find(
        (message) => message.role === "developer" && message.content.includes("<context-summary"),
      );
      expect(summaryMessage).toMatchObject({ role: "developer" });
      if (summaryMessage?.role !== "developer") {
        throw new Error("The compacted projection did not contain a summary message.");
      }
      expect(summaryMessage.content).toContain("<context-evidence");
      expect(summaryMessage.content).toContain("output.txt");
      expect(summaryMessage.content).toContain('"decision":"allow"');
      expect(summaryMessage.content).toContain('"callId":"write-evidence"');
      yield { type: "text_delta", text: "Canonical evidence survived compaction." };
      yield { type: "usage", inputTokens: 120, outputTokens: 15 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const dependencies = {
    model,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    tools: createCodingToolRegistry({ workspaceRoot, stateRoot: join(testRoot, "state") }),
    permissions: createPermissionPolicy({ allowedEffects: ["read", "write"] }),
    [sessionDurableContext]: { nextSequence: 2, targetIdentity },
    contextProfile: contextProfile,
  };
  const session = new AgentSession(dependencies);

  try {
    await expect(
      session.run({ text: "Read context.txt, write output.txt, and continue safely." }),
    ).resolves.toEqual({
      status: "completed",
      answer: "Canonical evidence survived compaction.",
    });
    expect(fittedSummaryInput).not.toContain("VERY_LATE_CONTEXT_TAIL");
    expect(fittedSummaryInput).toContain('"truncated":true');
    expect(fittedSummaryInput).toContain('"digest":"sha256:');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession reconsiders a complete retained tool turn during repeated compaction", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-context-repeat-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "first.txt"), "first retained fact ".repeat(20), "utf8");
  await writeFile(join(workspaceRoot, "second.txt"), "second retained fact ".repeat(20), "utf8");

  const store = createInMemorySessionStore<SessionRecord>();
  await store.append({
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      sessionId: "50000000-0000-4000-8000-000000000005",
      projectId: `sha256:${"4".repeat(64)}`,
      targetIdentity,
    },
  });
  const repeatedProfile: ContextProfile = {
    ...contextProfile,
    contextWindowTokens: 20_000,
    maximumOutputTokens: 100,
    compactAtTokens: 500,
    postCompactTargetTokens: 450,
    retainedTargetTokens: 300,
  };
  let ordinaryCall = 0;
  let compactionCall = 0;
  let secondCompactionInput = "";
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        compactionCall += 1;
        const inputMessage = request.messages.at(-1);
        if (
          compactionCall === 2 &&
          inputMessage?.role === "user" &&
          typeof inputMessage.content === "string"
        ) {
          secondCompactionInput = inputMessage.content;
        }
        yield {
          type: "text_delta",
          text: JSON.stringify({
            schemaVersion: 1,
            objective: `Repeated context window ${compactionCall}.`,
            constraints: [],
            progress: [`Compaction ${compactionCall} completed.`],
            unresolvedQuestions: [],
            failures: [],
            remainingVerification: [],
            nextSafeAction: "Continue the repeated tool run.",
          }),
        };
        yield { type: "usage", inputTokens: 140, outputTokens: 20 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      ordinaryCall += 1;
      if (ordinaryCall <= 2) {
        const suffix = ordinaryCall === 1 ? "first" : "second";
        yield { type: "usage", inputTokens: 450, outputTokens: 10 };
        yield { type: "tool_call_start", id: `read-${suffix}`, name: "read_file" };
        yield {
          type: "tool_call_delta",
          id: `read-${suffix}`,
          json: `{"path":"${suffix}.txt"}`,
        };
        yield { type: "tool_call_end", id: `read-${suffix}` };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      const toolMessages = request.messages.filter((message) => message.role === "tool");
      expect(toolMessages.map((message) => message.callId)).toContain("read-second");
      for (const toolMessage of toolMessages) {
        const assistantIndex = request.messages.findIndex(
          (message) =>
            message.role === "assistant" &&
            message.toolCalls.some((call) => call.id === toolMessage.callId),
        );
        expect(assistantIndex).toBeGreaterThanOrEqual(0);
      }
      yield { type: "text_delta", text: "Repeated compaction preserved complete turns." };
      yield { type: "usage", inputTokens: 80, outputTokens: 10 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const dependencies = {
    model,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    tools: createReadToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    [sessionDurableContext]: { nextSequence: 2, targetIdentity },
    contextProfile: repeatedProfile,
  };
  const session = new AgentSession(dependencies);

  try {
    await expect(
      session.run({
        text: `Read both files across repeated compaction. ${"Preserve the older objective. ".repeat(60)}`,
      }),
    ).resolves.toEqual({
      status: "completed",
      answer: "Repeated compaction preserved complete turns.",
    });
    expect(compactionCall).toBe(2);
    expect(secondCompactionInput).toContain("read-first");
    const checkpoints = (await store.read()).filter(
      (record) =>
        record.schemaVersion === 3 && record.record.type === "context_compaction_committed",
    ) as readonly SessionContextCompactionCommittedRecord[];
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints.map((record) => record.record)).toMatchObject([
      { type: "context_compaction_committed", windowNumber: 1 },
      {
        type: "context_compaction_committed",
        windowNumber: 2,
        previousCheckpointSequence: expect.any(Number),
      },
    ]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession preserves edit, shell-artifact, and failure evidence through compaction", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-context-tool-evidence-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "fruit.txt"), "apple\n", "utf8");

  const store = createInMemorySessionStore<SessionRecord>();
  await store.append({
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      sessionId: "60000000-0000-4000-8000-000000000006",
      projectId: `sha256:${"5".repeat(64)}`,
      targetIdentity,
    },
  });
  const evidenceProfile: ContextProfile = {
    ...contextProfile,
    compactAtTokens: 600,
    postCompactTargetTokens: 550,
    retainedTargetTokens: 80,
  };
  let ordinaryCall = 0;
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        yield {
          type: "text_delta",
          text: JSON.stringify({
            schemaVersion: 1,
            objective: "Preserve completed and failed tool evidence.",
            constraints: [],
            progress: [],
            unresolvedQuestions: [],
            failures: [],
            remainingVerification: [],
            nextSafeAction: "Continue after inspecting canonical evidence.",
          }),
        };
        yield { type: "usage", inputTokens: 260, outputTokens: 25 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      ordinaryCall += 1;
      if (ordinaryCall === 1) {
        yield { type: "usage", inputTokens: 550, outputTokens: 20 };
        yield { type: "tool_call_start", id: "edit-evidence", name: "edit_file" };
        yield {
          type: "tool_call_delta",
          id: "edit-evidence",
          json: JSON.stringify({
            operations: [
              {
                kind: "update",
                path: "fruit.txt",
                edits: [{ oldText: "apple", newText: "pear" }],
              },
            ],
          }),
        };
        yield { type: "tool_call_end", id: "edit-evidence" };
        yield { type: "tool_call_start", id: "shell-evidence", name: "run_shell" };
        yield {
          type: "tool_call_delta",
          id: "shell-evidence",
          json: JSON.stringify({ command: `printf '${"0123456789".repeat(40)}'` }),
        };
        yield { type: "tool_call_end", id: "shell-evidence" };
        yield { type: "tool_call_start", id: "read-failure", name: "read_file" };
        yield {
          type: "tool_call_delta",
          id: "read-failure",
          json: '{"path":"missing.txt"}',
        };
        yield { type: "tool_call_end", id: "read-failure" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      const summaryMessage = request.messages.find(
        (message) => message.role === "developer" && message.content.includes("<context-evidence"),
      );
      expect(summaryMessage?.role).toBe("developer");
      if (summaryMessage?.role === "developer") {
        expect(summaryMessage.content).toContain("fruit.txt");
        expect(summaryMessage.content).toContain("shell-evidence");
        expect(summaryMessage.content).toContain("not_found");
        expect(summaryMessage.content).toContain("sha256:");
      }
      yield { type: "text_delta", text: "All protected tool evidence was available." };
      yield { type: "usage", inputTokens: 110, outputTokens: 12 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const artifactStore = await createFileArtifactStore({ root: join(stateRoot, "artifacts") });
  const dependencies = {
    model,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    tools: createCodingToolRegistry({
      workspaceRoot,
      stateRoot,
      artifactStore,
      shellLimits: {
        timeoutMs: 10_000,
        terminationGraceMs: 100,
        maximumInlineBytesPerStream: 32,
        maximumArtifactBytesPerStream: 4 * 1024,
      },
    }),
    permissions: createPermissionPolicy({ allowedEffects: ["read", "write", "execute"] }),
    [sessionDurableContext]: { nextSequence: 2, targetIdentity },
    contextProfile: evidenceProfile,
  };
  const session = new AgentSession(dependencies);

  try {
    await expect(
      session.run({
        text: `Edit fruit.txt, run the bounded shell, and read missing.txt. ${"Keep evidence. ".repeat(80)}`,
      }),
    ).resolves.toEqual({
      status: "completed",
      answer: "All protected tool evidence was available.",
    });
    const checkpoint = (await store.read()).find(
      (record) =>
        record.schemaVersion === 3 && record.record.type === "context_compaction_committed",
    ) as SessionContextCompactionCommittedRecord | undefined;
    expect(checkpoint?.record).toMatchObject({
      type: "context_compaction_committed",
      evidence: {
        modifiedFiles: [expect.objectContaining({ path: "fruit.txt", callId: "edit-evidence" })],
        toolResults: expect.arrayContaining([
          expect.objectContaining({ callId: "shell-evidence", artifactIds: [expect.any(String)] }),
        ]),
        failures: [expect.objectContaining({ callId: "read-failure", code: "not_found" })],
      },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession retries one valid but oversized compaction candidate before one commit", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-context-retry-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "large-turn.txt"), "retained turn data ".repeat(28), "utf8");

  const store = createInMemorySessionStore<SessionRecord>();
  await store.append({
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      sessionId: "70000000-0000-4000-8000-000000000007",
      projectId: `sha256:${"6".repeat(64)}`,
      targetIdentity,
    },
  });
  const retryProfile: ContextProfile = {
    ...contextProfile,
    contextWindowTokens: 20_000,
    maximumOutputTokens: 60,
    compactAtTokens: 400,
    postCompactTargetTokens: 250,
    retainedTargetTokens: 300,
  };
  let ordinaryCall = 0;
  let compactionCall = 0;
  const compactionInputBytes: number[] = [];
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        compactionCall += 1;
        compactionInputBytes.push(Buffer.byteLength(JSON.stringify(request.messages), "utf8"));
        yield {
          type: "text_delta",
          text: JSON.stringify({
            schemaVersion: 1,
            objective: "Finish after bounded compaction retry.",
            constraints: [],
            progress: [],
            unresolvedQuestions: [],
            failures: [],
            remainingVerification: [],
            nextSafeAction: "Continue with the fitting candidate.",
          }),
        };
        yield { type: "usage", inputTokens: 210, outputTokens: 20 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      ordinaryCall += 1;
      if (ordinaryCall === 1) {
        yield { type: "usage", inputTokens: 350, outputTokens: 10 };
        yield { type: "tool_call_start", id: "read-large-turn", name: "read_file" };
        yield {
          type: "tool_call_delta",
          id: "read-large-turn",
          json: '{"path":"large-turn.txt"}',
        };
        yield { type: "tool_call_end", id: "read-large-turn" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "The second candidate fit." };
      yield { type: "usage", inputTokens: 80, outputTokens: 8 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const dependencies = {
    model,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    tools: createReadToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    [sessionDurableContext]: { nextSequence: 2, targetIdentity },
    contextProfile: retryProfile,
  };
  const session = new AgentSession(dependencies);

  try {
    await expect(
      session.run({
        text: `Read large-turn.txt and finish. ${"Older objective detail. ".repeat(60)}`,
      }),
    ).resolves.toEqual({ status: "completed", answer: "The second candidate fit." });
    expect(compactionCall).toBe(2);
    expect(compactionInputBytes[1]).toBeLessThan(compactionInputBytes[0] ?? 0);
    const records = await store.read();
    const starts = records.filter(
      (record) => record.schemaVersion === 3 && record.record.type === "context_compaction_started",
    );
    const failures = records.filter(
      (record) => record.schemaVersion === 3 && record.record.type === "context_compaction_failed",
    ) as readonly SessionContextCompactionFailedRecord[];
    const commits = records.filter(
      (record) =>
        record.schemaVersion === 3 && record.record.type === "context_compaction_committed",
    ) as readonly SessionContextCompactionCommittedRecord[];
    expect(
      starts.map((record) => (record.schemaVersion === 3 ? record.record : undefined)),
    ).toMatchObject([
      { type: "context_compaction_started", attemptNumber: 1, windowNumber: 1 },
      { type: "context_compaction_started", attemptNumber: 2, windowNumber: 1 },
    ]);
    expect(failures.map((record) => record.record)).toMatchObject([
      {
        type: "context_compaction_failed",
        attemptNumber: 1,
        reason: "replacement_too_large",
      },
    ]);
    expect(commits.map((record) => record.record)).toMatchObject([
      { type: "context_compaction_committed", attemptNumber: 2, windowNumber: 1 },
    ]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession preserves unknown usage across a successful compaction retry under maxTokens", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-context-retry-unknown-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "large-turn.txt"), "retained turn data ".repeat(28), "utf8");

  const store = createInMemorySessionStore<SessionRecord>();
  await store.append({
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      sessionId: "71000000-0000-4000-8000-000000000071",
      projectId: `sha256:${"1".repeat(64)}`,
      targetIdentity,
    },
  });
  const retryProfile: ContextProfile = {
    ...contextProfile,
    contextWindowTokens: 20_000,
    maximumOutputTokens: 60,
    compactAtTokens: 400,
    postCompactTargetTokens: 250,
    retainedTargetTokens: 300,
  };
  let ordinaryCall = 0;
  let compactionCall = 0;
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        compactionCall += 1;
        yield {
          type: "text_delta",
          text: JSON.stringify({
            schemaVersion: 1,
            objective: "Stop when any retry usage is unknown.",
            constraints: [],
            progress: [],
            unresolvedQuestions: [],
            failures: [],
            remainingVerification: [],
            nextSafeAction: "Honor fail-closed token accounting.",
          }),
        };
        if (compactionCall === 2) {
          yield { type: "usage", inputTokens: 210, outputTokens: 20 };
        }
        yield { type: "finish", reason: "stop" };
        return;
      }
      ordinaryCall += 1;
      if (ordinaryCall > 1) {
        yield { type: "text_delta", text: "This ordinary call should have been blocked." };
        yield { type: "usage", inputTokens: 80, outputTokens: 8 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      yield { type: "usage", inputTokens: 350, outputTokens: 10 };
      yield { type: "tool_call_start", id: "read-retry-unknown", name: "read_file" };
      yield {
        type: "tool_call_delta",
        id: "read-retry-unknown",
        json: '{"path":"large-turn.txt"}',
      };
      yield { type: "tool_call_end", id: "read-retry-unknown" };
      yield { type: "finish", reason: "tool_calls" };
    },
  };
  const dependencies = {
    model,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    tools: createReadToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    [sessionDurableContext]: { nextSequence: 2, targetIdentity },
    contextProfile: retryProfile,
  };
  const session = new AgentSession(dependencies);

  try {
    const result = await session.run(
      { text: `Read large-turn.txt and finish. ${"Older objective detail. ".repeat(60)}` },
      { limits: { maxTokens: 10_000 } },
    );
    const commits = (await store.read()).filter(
      (record) =>
        record.schemaVersion === 3 && record.record.type === "context_compaction_committed",
    );
    expect({ result, compactionCall, ordinaryCall, commits }).toMatchObject({
      result: {
        status: "failed",
        error: {
          code: "token_usage_missing",
          message: "The provider did not report token usage for an active token limit.",
        },
      },
      compactionCall: 2,
      ordinaryCall: 1,
      commits: [expect.any(Object)],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession rejects malformed compaction output without retry or an ordinary call", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-context-invalid-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, "context.txt"),
    "invalid summary source ".repeat(180),
    "utf8",
  );

  const store = createInMemorySessionStore<SessionRecord>();
  await store.append({
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      sessionId: "80000000-0000-4000-8000-000000000008",
      projectId: `sha256:${"7".repeat(64)}`,
      targetIdentity,
    },
  });
  let ordinaryCall = 0;
  let compactionCall = 0;
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        compactionCall += 1;
        yield { type: "text_delta", text: '{"schemaVersion":1,"objective":42}' };
        yield { type: "usage", inputTokens: 520, outputTokens: 12 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      ordinaryCall += 1;
      if (ordinaryCall > 1) {
        throw new Error("Malformed compaction must stop before another ordinary call.");
      }
      yield { type: "usage", inputTokens: 30, outputTokens: 10 };
      yield { type: "tool_call_start", id: "read-invalid-summary", name: "read_file" };
      yield {
        type: "tool_call_delta",
        id: "read-invalid-summary",
        json: '{"path":"context.txt"}',
      };
      yield { type: "tool_call_end", id: "read-invalid-summary" };
      yield { type: "finish", reason: "tool_calls" };
    },
  };
  const dependencies = {
    model,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    tools: createReadToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    [sessionDurableContext]: { nextSequence: 2, targetIdentity },
    contextProfile: contextProfile,
  };
  const session = new AgentSession(dependencies);

  try {
    await expect(
      session.run({ text: "Read context.txt before malformed compaction." }),
    ).resolves.toEqual({
      status: "failed",
      error: {
        code: "context_compaction_invalid",
        message: "The context compaction response did not match the required schema.",
      },
    });
    expect(compactionCall).toBe(1);
    expect(ordinaryCall).toBe(1);
    const records = await store.read();
    expect(
      records.filter(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "context_compaction_failed",
      ),
    ).toMatchObject([
      {
        record: {
          type: "context_compaction_failed",
          attemptNumber: 1,
          reason: "summary_invalid",
          usage: { inputTokens: 520, outputTokens: 12 },
        },
      },
    ]);
    expect(
      records.some(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "context_compaction_committed",
      ),
    ).toBe(false);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession records one compaction authentication failure without retry", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-context-provider-failure-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, "context.txt"),
    "provider failure context ".repeat(180),
    "utf8",
  );

  const store = createInMemorySessionStore<SessionRecord>();
  await store.append({
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      sessionId: "90000000-0000-4000-8000-000000000009",
      projectId: `sha256:${"8".repeat(64)}`,
      targetIdentity,
    },
  });
  let ordinaryCall = 0;
  let compactionCall = 0;
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        compactionCall += 1;
        yield { type: "usage", inputTokens: 500, outputTokens: 7 };
        throw new ModelDriverError(
          "authentication",
          "The compaction provider rejected authentication.",
          {
            cause: new Error("authentication failed"),
            status: 401,
            providerCode: "invalid_api_key",
            requestId: "request-compaction-failed",
          },
        );
      }
      ordinaryCall += 1;
      if (ordinaryCall > 1) {
        throw new Error("Provider compaction failure must stop the ordinary loop.");
      }
      yield { type: "usage", inputTokens: 30, outputTokens: 10 };
      yield { type: "tool_call_start", id: "read-provider-failure", name: "read_file" };
      yield {
        type: "tool_call_delta",
        id: "read-provider-failure",
        json: '{"path":"context.txt"}',
      };
      yield { type: "tool_call_end", id: "read-provider-failure" };
      yield { type: "finish", reason: "tool_calls" };
    },
  };
  const dependencies = {
    model,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    tools: createReadToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    [sessionDurableContext]: { nextSequence: 2, targetIdentity },
    contextProfile: contextProfile,
  };
  const session = new AgentSession(dependencies);

  try {
    await expect(
      session.run({ text: "Read context.txt before provider failure." }),
    ).resolves.toEqual({
      status: "failed",
      error: {
        code: "context_compaction_failed",
        message: "The context compaction model request failed.",
        category: "authentication",
        status: 401,
        providerCode: "invalid_api_key",
        requestId: "request-compaction-failed",
      },
    });
    expect(compactionCall).toBe(1);
    expect(ordinaryCall).toBe(1);
    expect(
      (await store.read()).filter(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "context_compaction_failed",
      ),
    ).toMatchObject([
      {
        record: {
          type: "context_compaction_failed",
          attemptNumber: 1,
          reason: "model_request_failed",
          usage: { inputTokens: 500, outputTokens: 7 },
        },
      },
    ]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession records one compaction deadline failure without retry", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-context-deadline-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const store = createInMemorySessionStore<SessionRecord>();
  await store.append({
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      sessionId: "91000000-0000-4000-8000-000000000091",
      projectId: `sha256:${"8".repeat(64)}`,
      targetIdentity,
    },
  });
  let ordinaryCall = 0;
  let compactionCall = 0;
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        compactionCall += 1;
        throw new ModelDriverError("timeout", "The compaction request exceeded its deadline.", {
          cause: new Error("deadline exceeded"),
          providerCode: "deadline_exceeded",
          requestId: "request-compaction-timeout",
        });
      }
      ordinaryCall += 1;
      yield { type: "finish", reason: "stop" };
    },
  };
  const dependencies = {
    model,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    tools: createReadToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    [sessionDurableContext]: { nextSequence: 2, targetIdentity },
    contextProfile: contextProfile,
  };
  const session = new AgentSession(dependencies);

  try {
    await expect(
      session.run({ text: `Preserve the deadline context. ${"deadline ".repeat(400)}` }),
    ).resolves.toEqual({
      status: "failed",
      error: {
        code: "context_compaction_failed",
        message: "The context compaction model request failed.",
        category: "timeout",
        providerCode: "deadline_exceeded",
        requestId: "request-compaction-timeout",
      },
    });
    expect({ ordinaryCall, compactionCall }).toEqual({ ordinaryCall: 0, compactionCall: 1 });
    expect(
      (await store.read()).filter(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "context_compaction_started",
      ),
    ).toHaveLength(1);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession cancels one active compaction and records an interrupted attempt", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-context-cancel-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "context.txt"), "cancel context ".repeat(260), "utf8");

  const store = createInMemorySessionStore<SessionRecord>();
  await store.append({
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      sessionId: "a0000000-0000-4000-8000-00000000000a",
      projectId: `sha256:${"9".repeat(64)}`,
      targetIdentity,
    },
  });
  let ordinaryCall = 0;
  let compactionCall = 0;
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        compactionCall += 1;
        yield { type: "usage", inputTokens: 500, outputTokens: 7 };
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) {
            resolve();
            return;
          }
          request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return;
      }
      ordinaryCall += 1;
      yield { type: "usage", inputTokens: 30, outputTokens: 10 };
      yield { type: "tool_call_start", id: "read-before-cancel", name: "read_file" };
      yield {
        type: "tool_call_delta",
        id: "read-before-cancel",
        json: '{"path":"context.txt"}',
      };
      yield { type: "tool_call_end", id: "read-before-cancel" };
      yield { type: "finish", reason: "tool_calls" };
    },
  };
  const dependencies = {
    model,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    tools: createReadToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    [sessionDurableContext]: { nextSequence: 2, targetIdentity },
    contextProfile: contextProfile,
  };
  const session = new AgentSession(dependencies);
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  session.subscribe((event) => {
    if (event.type === "context_compaction_started") {
      markStarted?.();
    }
  });

  try {
    const resultPromise = session.run({ text: "Read context.txt before cancellation." });
    await started;
    session.abort();
    await expect(resultPromise).resolves.toEqual({
      status: "cancelled",
      error: { code: "session_cancelled", message: "The session was cancelled." },
    });
    expect({ ordinaryCall, compactionCall }).toEqual({ ordinaryCall: 1, compactionCall: 1 });
    const interruptions = (await store.read()).filter(
      (record) =>
        record.schemaVersion === 3 && record.record.type === "context_compaction_interrupted",
    ) as readonly SessionContextCompactionInterruptedRecord[];
    expect(interruptions.map((record) => record.record)).toMatchObject([
      {
        type: "context_compaction_interrupted",
        attemptNumber: 1,
        reason: "caller_cancelled",
        usage: { inputTokens: 500, outputTokens: 7 },
      },
    ]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession reactively compacts one pre-response context overflow without duplicating effects", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-context-overflow-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "context.txt"), "small durable fact\n", "utf8");

  const store = createInMemorySessionStore<SessionRecord>();
  await store.append({
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      sessionId: "b0000000-0000-4000-8000-00000000000b",
      projectId: `sha256:${"a".repeat(64)}`,
      targetIdentity,
    },
  });
  const overflowProfile: ContextProfile = {
    ...contextProfile,
    contextWindowTokens: 2_000,
    maximumOutputTokens: 200,
    compactAtTokens: 1_500,
    postCompactTargetTokens: 1_000,
    retainedTargetTokens: 100,
  };
  let ordinaryCall = 0;
  let compactionCall = 0;
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        compactionCall += 1;
        yield {
          type: "text_delta",
          text: JSON.stringify({
            schemaVersion: 1,
            objective: "Recover the overflowing turn.",
            constraints: [],
            progress: ["The read effect completed once."],
            unresolvedQuestions: [],
            failures: ["The ordinary context overflowed before a response."],
            remainingVerification: [],
            nextSafeAction: "Retry the same ordinary turn once.",
          }),
        };
        yield { type: "usage", inputTokens: 180, outputTokens: 25 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      ordinaryCall += 1;
      if (ordinaryCall === 1) {
        yield { type: "usage", inputTokens: 30, outputTokens: 10 };
        yield { type: "tool_call_start", id: "read-once", name: "read_file" };
        yield { type: "tool_call_delta", id: "read-once", json: '{"path":"context.txt"}' };
        yield { type: "tool_call_end", id: "read-once" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      if (ordinaryCall === 2) {
        throw new ModelDriverError("invalid_request", "The provider rejected the context length.", {
          cause: new Error("context length exceeded"),
          status: 400,
          providerCode: "context_length_exceeded",
          requestId: "overflow-attempt",
        });
      }
      expect(
        request.messages.some(
          (message) => message.role === "developer" && message.content.includes("<context-summary"),
        ),
      ).toBe(true);
      yield { type: "text_delta", text: "Reactive compaction recovered the turn." };
      yield { type: "usage", inputTokens: 90, outputTokens: 12 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const dependencies = {
    model,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    tools: createReadToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    [sessionDurableContext]: { nextSequence: 2, targetIdentity },
    contextProfile: overflowProfile,
  };
  const session = new AgentSession(dependencies);

  try {
    await expect(
      session.run({ text: "Read context.txt and recover one overflow." }),
    ).resolves.toEqual({
      status: "completed",
      answer: "Reactive compaction recovered the turn.",
    });
    expect({ ordinaryCall, compactionCall }).toEqual({ ordinaryCall: 3, compactionCall: 1 });
    const records = await store.read();
    expect(
      records.filter(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "provider_attempt_interrupted",
      ),
    ).toMatchObject([
      {
        record: {
          type: "provider_attempt_interrupted",
          turn: 2,
          attempt: 1,
          reason: "context_overflow",
        },
      },
    ]);
    expect(
      records.filter(
        (record) => record.schemaVersion === 3 && record.record.type === "provider_attempt_started",
      ),
    ).toMatchObject([
      { record: { turn: 1, attempt: 1 } },
      { record: { turn: 2, attempt: 1 } },
      { record: { turn: 2, attempt: 2 } },
    ]);
    expect(
      records.filter(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "runtime_event" &&
          record.record.event.type === "tool_started",
      ),
    ).toHaveLength(1);
    expect(
      records.filter(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "context_compaction_committed",
      ),
    ).toMatchObject([{ record: { trigger: "provider_overflow", windowNumber: 1 } }]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession stops after the one reactive ordinary retry also overflows", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-context-overflow-stop-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const store = createInMemorySessionStore<SessionRecord>();
  await store.append({
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      sessionId: "b1000000-0000-4000-8000-00000000000b",
      projectId: `sha256:${"d".repeat(64)}`,
      targetIdentity,
    },
  });
  const overflowProfile: ContextProfile = {
    ...contextProfile,
    contextWindowTokens: 2_000,
    maximumOutputTokens: 200,
    compactAtTokens: 1_500,
    postCompactTargetTokens: 1_000,
  };
  let ordinaryCall = 0;
  let compactionCall = 0;
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        compactionCall += 1;
        yield {
          type: "text_delta",
          text: JSON.stringify({
            schemaVersion: 1,
            objective: "Try one reactive recovery.",
            constraints: [],
            progress: [],
            unresolvedQuestions: [],
            failures: ["The provider overflowed."],
            remainingVerification: [],
            nextSafeAction: "Retry once.",
          }),
        };
        yield { type: "usage", inputTokens: 100, outputTokens: 15 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      ordinaryCall += 1;
      throw new ModelDriverError("invalid_request", "The context is still too long.", {
        cause: new Error("context length exceeded"),
        status: 400,
        providerCode: "context_length_exceeded",
        requestId: `overflow-${ordinaryCall}`,
      });
    },
  };
  const dependencies = {
    model,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    tools: createReadToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    [sessionDurableContext]: { nextSequence: 2, targetIdentity },
    contextProfile: overflowProfile,
  };
  const session = new AgentSession(dependencies);

  try {
    await expect(session.run({ text: "Stop after one reactive retry." })).resolves.toEqual({
      status: "failed",
      error: {
        code: "context_window_unrecoverable",
        message: "The provider still rejected the compacted context window.",
      },
    });
    expect({ ordinaryCall, compactionCall }).toEqual({ ordinaryCall: 2, compactionCall: 1 });
    expect(
      (await store.read()).filter(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "provider_attempt_interrupted",
      ),
    ).toMatchObject([
      { record: { turn: 1, attempt: 1, reason: "context_overflow" } },
      { record: { turn: 1, attempt: 2, reason: "context_overflow" } },
    ]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession never retries a context overflow after ordinary output has begun", async () => {
  const store = createInMemorySessionStore<SessionRecord>();
  await store.append({
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      sessionId: "b2000000-0000-4000-8000-00000000000b",
      projectId: `sha256:${"b".repeat(64)}`,
      targetIdentity,
    },
  });
  let ordinaryCall = 0;
  let compactionCall = 0;
  const model: ModelDriver = {
    async *stream(request) {
      if (request.messages[0]?.role === "system") {
        compactionCall += 1;
        yield { type: "finish", reason: "stop" };
        return;
      }
      ordinaryCall += 1;
      yield { type: "text_delta", text: "Partial ordinary output." };
      throw new ModelDriverError("invalid_request", "The provider rejected the context length.", {
        cause: new Error("context length exceeded after output"),
        status: 400,
        providerCode: "context_length_exceeded",
        requestId: "overflow-after-output",
      });
    },
  };
  const dependencies = {
    model,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    [sessionDurableContext]: { nextSequence: 2, targetIdentity },
    contextProfile: contextProfile,
  };
  const session = new AgentSession(dependencies);

  await expect(session.run({ text: "Do not retry after partial output." })).resolves.toEqual({
    status: "failed",
    error: {
      code: "model_request_failed",
      message: "The provider rejected the context length.",
      category: "invalid_request",
      status: 400,
      providerCode: "context_length_exceeded",
      requestId: "overflow-after-output",
    },
  });
  expect({ ordinaryCall, compactionCall }).toEqual({ ordinaryCall: 1, compactionCall: 0 });
  expect(
    (await store.read()).filter(
      (record) => record.schemaVersion === 3 && record.record.type === "context_compaction_started",
    ),
  ).toHaveLength(0);
});

test("SessionLifecycle retains canonical input-resource identity for reread after compaction", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-input-resource-compaction-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const selectedPath = join(testRoot, "compaction-resource.txt");
  const content = "Canonical resource bytes survive compaction.\n";
  const runId = "50000000-0000-4000-8000-000000000011";
  const occurrenceId = `${runId}:input:1`;
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, content, "utf8");
  const compactionProfile: ContextProfile = {
    ...contextProfile,
    compactAtTokens: 900,
    postCompactTargetTokens: 800,
    retainedTargetTokens: 0,
  };
  let compactionCalls = 0;
  let ordinaryCalls = 0;
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        compactionCalls += 1;
        yield {
          type: "text_delta",
          text: JSON.stringify({
            schemaVersion: 1,
            objective: "Read the linked evidence after compaction.",
            constraints: [],
            progress: [],
            unresolvedQuestions: [],
            failures: [],
            remainingVerification: ["Read the linked evidence."],
            nextSafeAction: "Use the resource tool.",
          }),
        };
        yield { type: "usage", inputTokens: 600, outputTokens: 30 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      ordinaryCalls += 1;
      expect(JSON.stringify(request.messages)).toContain(occurrenceId);
      if (ordinaryCalls === 1) {
        yield {
          type: "tool_call_start",
          id: "resource-after-compaction",
          name: "read_input_resource",
        };
        yield {
          type: "tool_call_delta",
          id: "resource-after-compaction",
          json: JSON.stringify({ occurrenceId }),
        };
        yield { type: "tool_call_end", id: "resource-after-compaction" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      expect(request.messages.at(-1)).toMatchObject({
        role: "tool",
        callId: "resource-after-compaction",
        name: "read_input_resource",
        result: { status: "completed", output: { occurrenceId, content } },
      });
      yield { type: "text_delta", text: "The canonical resource remained readable." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile: compactionProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "test" },
            contextProfile: compactionProfile,
          },
        ],
      };
    },
  };
  const currentTools = createCodingToolRegistry({ stateRoot, workspaceRoot });
  const tools: ToolRegistry = {
    definitions: () =>
      currentTools.definitions().filter((definition) => definition.name === "read_input_resource"),
    resolve: (name) => (name === "read_input_resource" ? currentTools.resolve(name) : undefined),
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, tools, workspaceRoot });

  try {
    const admitted = await lifecycle.admit({
      targetIdentity,
      input: {
        text: `Keep the linked resource canonical. ${"Summarize this filler. ".repeat(220)}`,
      },
      resourceSelections: [{ type: "local_file", path: selectedPath }],
      runId,
    });
    expect(admitted).toMatchObject({
      result: { status: "completed", answer: "The canonical resource remained readable." },
      snapshot: { context: { checkpoint: { status: "committed" } } },
    });
    expect({ compactionCalls, ordinaryCalls }).toEqual({ compactionCalls: 1, ordinaryCalls: 2 });
    const store = await openJsonlSessionStore({
      stateRoot,
      workspaceRoot,
      sessionId: admitted.snapshot.sessionId,
    });
    expect(await store.read()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record: expect.objectContaining({
            type: "context_compaction_committed",
            inputResources: [expect.objectContaining({ occurrenceId })],
          }),
        }),
      ]),
    );
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession projects an eager Vision Chat image into compaction without synthesizing a replacement user turn", async () => {
  const imageBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const artifactId = `sha256:${createHash("sha256").update(imageBytes).digest("hex")}` as const;
  const visionIdentity = {
    targetId: "deepseek-v4-flash-vision-exp.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-flash-vision-exp",
    route: "direct",
    profileVersion: 1,
    certification: "certified",
  } as const;
  const occurrence = {
    occurrenceId: "image-compaction-run:input:1",
    displayName: "compacted-image.png",
    artifact: { id: artifactId, mediaType: "image/png" as const, byteCount: imageBytes.byteLength },
    digest: artifactId,
    mediaHint: "image" as const,
    provenance: "user_local_file" as const,
    support: "image" as const,
    mode: "link" as const,
  };
  const userText = `Retain and describe this image. ${"Summarize this filler. ".repeat(3_000)}`;
  const compactionProfile: ContextProfile = {
    ...preparedDirectDeepSeekV2ContextProfile,
    contextWindowTokens: 20_000,
    maximumOutputTokens: 1_000,
    ordinaryOutputReserveTokens: 1_000,
    compactionSummaryMaximumOutputTokens: 1_000,
    compactAtTokens: 8_000,
    postCompactTargetTokens: 6_000,
    retainedTargetTokens: 0,
  };
  let compactionCalls = 0;
  let ordinaryCalls = 0;
  const model: ModelDriver = {
    async *stream(request) {
      const imageParts = request.messages.flatMap((message) =>
        message.role === "user" && typeof message.content !== "string"
          ? message.content.filter((part) => part.type === "file")
          : [],
      );
      if (request.purpose === "compaction") {
        compactionCalls += 1;
        const wrapper = request.messages.at(-1);
        expect(wrapper?.role).toBe("user");
        if (wrapper?.role !== "user" || typeof wrapper.content === "string") {
          throw new Error("Expected one image-bearing compaction request wrapper.");
        }
        const instructionPart = wrapper.content[0];
        if (instructionPart?.type !== "text") {
          throw new Error("Expected the compaction instruction text before its image.");
        }
        const instruction = JSON.parse(instructionPart.text) as { readonly messages?: unknown };
        expect(instruction.messages).toEqual([
          {
            role: "user",
            content: [
              { type: "text", text: userText },
              {
                type: "image_attachment",
                attachmentIndex: 0,
                artifactId,
                mediaType: "image/png",
                byteCount: imageBytes.byteLength,
              },
            ],
          },
        ]);
        expect(imageParts).toEqual([
          expect.objectContaining({
            type: "file",
            mediaType: "image/png",
            bytes: new Uint8Array(imageBytes),
          }),
        ]);
        yield {
          type: "text_delta",
          text: JSON.stringify({
            schemaVersion: 1,
            objective: "Describe the retained image after compaction.",
            constraints: [],
            progress: [],
            unresolvedQuestions: [],
            failures: [],
            remainingVerification: ["Inspect the retained image."],
            nextSafeAction: "Answer from the retained image.",
          }),
        };
        yield { type: "usage", inputTokens: 600, outputTokens: 30 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      ordinaryCalls += 1;
      expect(imageParts).toEqual([]);
      yield { type: "text_delta", text: "The compacted image summary remained visible." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const artifactStore: ArtifactStore = {
    async write(input) {
      return {
        id: artifactId,
        mediaType: input.mediaType,
        byteCount: input.bytes.byteLength,
        source: input.source,
      };
    },
    async read(id) {
      return id === artifactId ? new Uint8Array(imageBytes) : undefined;
    },
  };
  const store = createInMemorySessionStore<SessionRecord>();
  const dependencies = {
    artifactStore,
    contextProfile: compactionProfile,
    modalityProfile: {
      profileVersion: 1 as const,
      explicitUserImages: "supported" as const,
      imageToolResults: "unsupported" as const,
    },
    model,
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    [sessionDurableContext]: {
      inputResources: [occurrence],
      nextSequence: 1,
      projectId: `sha256:${"e".repeat(64)}`,
      sessionId: "image-compaction-session",
      targetIdentity: visionIdentity,
    },
  };
  const session = new AgentSession(dependencies);

  await expect(
    session.run({
      text: userText,
      inputResources: [occurrence],
    }),
  ).resolves.toEqual({
    status: "completed",
    answer: "The compacted image summary remained visible.",
  });
  expect({ compactionCalls, ordinaryCalls }).toEqual({ compactionCalls: 1, ordinaryCalls: 1 });
  expect(
    (await store.read()).find(
      (record) => record.schemaVersion === 3 && record.record.type === "context_compaction_started",
    ),
  ).toMatchObject({
    record: {
      projectedContent: {
        version: 1,
        explicitUserImages: {
          count: 1,
          byteCount: imageBytes.byteLength,
          pixelCount: 1,
          maximumWidth: 1,
          maximumHeight: 1,
        },
      },
    },
  });
});

test("AgentSession keeps a lazy Vision Responses image as the real compaction function output", async () => {
  const imageBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const artifactId = `sha256:${createHash("sha256").update(imageBytes).digest("hex")}` as const;
  const occurrence = {
    occurrenceId: "lazy-image-compaction-run:input:1",
    displayName: "lazy-compacted-image.png",
    artifact: { id: artifactId, mediaType: "image/png" as const, byteCount: imageBytes.byteLength },
    digest: artifactId,
    mediaHint: "image" as const,
    provenance: "user_local_file" as const,
    support: "image" as const,
    mode: "link" as const,
  };
  const descriptor = {
    schemaVersion: 1 as const,
    type: "image" as const,
    occurrenceId: occurrence.occurrenceId,
    displayName: occurrence.displayName,
    artifactId,
    byteCount: imageBytes.byteLength,
    digest: artifactId,
    mediaType: "image/png" as const,
    width: 1,
    height: 1,
  };
  const userText = "Inspect the linked image through its resource tool.";
  const reasoning = "Inspect the image only after the tool returns it. ".repeat(5_000);
  const compactionProfile: ContextProfile = {
    ...preparedDirectDeepSeekV2ContextProfile,
    contextWindowTokens: 400_000,
    maximumOutputTokens: 1_000,
    ordinaryOutputReserveTokens: 1_000,
    compactionSummaryMaximumOutputTokens: 1_000,
    compactAtTokens: 50_000,
    postCompactTargetTokens: 40_000,
    retainedTargetTokens: 0,
  };
  let artifactReads = 0;
  const artifactStore: ArtifactStore = {
    async write(input) {
      return {
        id: artifactId,
        mediaType: input.mediaType,
        byteCount: input.bytes.byteLength,
        source: input.source,
      };
    },
    async read(id) {
      artifactReads += 1;
      return id === artifactId ? new Uint8Array(imageBytes) : undefined;
    },
  };
  let compactionCalls = 0;
  let ordinaryCalls = 0;
  const model: ModelDriver = {
    async *stream(request) {
      if (request.purpose === "compaction") {
        compactionCalls += 1;
        const assistantIndex = request.messages.findIndex(
          (message) => message.role === "assistant" && message.toolCalls.length === 1,
        );
        const wrapper = request.messages.find((message) => message.role === "user");
        const wrapperText =
          wrapper?.role === "user"
            ? typeof wrapper.content === "string"
              ? wrapper.content
              : wrapper.content.find((part) => part.type === "text")?.text
            : undefined;
        const wrappedMessages =
          wrapperText === undefined
            ? undefined
            : (
                JSON.parse(wrapperText) as {
                  readonly messages?: readonly {
                    readonly role?: unknown;
                    readonly callId?: unknown;
                    readonly content?: unknown;
                  }[];
                }
              ).messages;
        expect(
          assistantIndex,
          JSON.stringify({
            ordinaryCalls,
            projectedRoles:
              wrappedMessages === undefined
                ? undefined
                : wrappedMessages.map((message) => ({
                    role: message.role,
                    hasContent: message.content !== undefined,
                    ...(message.role === "tool" ? { message } : {}),
                  })),
            messages: request.messages.map((message) => ({
              role: message.role,
              ...(message.role === "assistant"
                ? { callIds: message.toolCalls.map((call) => call.id) }
                : {}),
              ...(message.role === "tool" ? { callId: message.callId } : {}),
            })),
          }),
        ).toBeGreaterThan(0);
        expect(
          wrappedMessages?.some(
            (message) => message.role === "tool" && message.callId === "sibling-read-before-image",
          ),
        ).toBe(true);
        expect(
          wrappedMessages?.some(
            (message) =>
              message.role === "tool" && message.callId === "lazy-image-before-compaction",
          ),
        ).toBe(true);
        expect(request.messages[assistantIndex]).toEqual({
          role: "assistant",
          content: "",
          reasoning,
          toolCalls: [
            {
              id: "lazy-image-before-compaction",
              name: "read_input_resource",
              argumentsJson: JSON.stringify({ occurrenceId: occurrence.occurrenceId }),
            },
          ],
        });
        expect(request.messages[assistantIndex + 1]).toEqual({
          role: "tool",
          callId: "lazy-image-before-compaction",
          name: "read_input_resource",
          result: { status: "completed", output: descriptor },
          content: [
            {
              type: "file",
              artifactId,
              mediaType: "image/png",
              bytes: new Uint8Array(imageBytes),
            },
          ],
        });
        expect(
          request.messages.flatMap((message) =>
            message.role === "user" && typeof message.content !== "string"
              ? message.content.filter((part) => part.type === "file")
              : [],
          ),
        ).toEqual([]);
        yield {
          type: "text_delta",
          text: JSON.stringify({
            schemaVersion: 1,
            objective: "Describe the tool-returned image.",
            constraints: ["Preserve the real function output identity."],
            progress: ["The image tool result was observed."],
            unresolvedQuestions: [],
            failures: [],
            remainingVerification: ["Answer from the observed image."],
            nextSafeAction: "Answer from the compacted image evidence.",
          }),
        };
        yield { type: "usage", inputTokens: 3_200, outputTokens: 40 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      ordinaryCalls += 1;
      if (ordinaryCalls === 1) {
        expect(
          request.messages.flatMap((message) =>
            message.role === "user" && typeof message.content !== "string"
              ? message.content.filter((part) => part.type === "file")
              : [],
          ),
        ).toEqual([]);
        yield {
          type: "reasoning_start",
          id: "lazy-image-reasoning",
          artifactType: "provider_reasoning",
        };
        yield { type: "reasoning_delta", id: "lazy-image-reasoning", text: reasoning };
        yield { type: "reasoning_end", id: "lazy-image-reasoning" };
        yield {
          type: "tool_call_start",
          id: "sibling-read-before-image",
          name: "read_file",
        };
        yield {
          type: "tool_call_delta",
          id: "sibling-read-before-image",
          json: JSON.stringify({ path: "missing-sibling.txt" }),
        };
        yield { type: "tool_call_end", id: "sibling-read-before-image" };
        yield {
          type: "tool_call_start",
          id: "lazy-image-before-compaction",
          name: "read_input_resource",
        };
        yield {
          type: "tool_call_delta",
          id: "lazy-image-before-compaction",
          json: JSON.stringify({ occurrenceId: occurrence.occurrenceId }),
        };
        yield { type: "tool_call_end", id: "lazy-image-before-compaction" };
        yield { type: "usage", inputTokens: 500, outputTokens: 3_000 };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "The image remained visible through compaction." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const currentTools = createCodingToolRegistry({ artifactStore, workspaceRoot: "/workspace" });
  const tools: ToolRegistry = {
    definitions: () =>
      currentTools
        .definitions()
        .filter(
          (definition) =>
            definition.name === "read_file" || definition.name === "read_input_resource",
        ),
    resolve: (name) =>
      name === "read_file" || name === "read_input_resource"
        ? currentTools.resolve(name)
        : undefined,
  };
  const store = createInMemorySessionStore<SessionRecord>();
  const session = new AgentSession({
    artifactStore,
    contextProfile: compactionProfile,
    modalityProfile: {
      profileVersion: 1,
      explicitUserImages: "unsupported",
      imageToolResults: "supported",
    },
    model,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    store: store as unknown as ConstructorParameters<typeof AgentSession>[0]["store"],
    tools,
    [sessionDurableContext]: {
      initialMessages: [
        { role: "user", content: "Record one ordinary failed read first." },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "lazy-image-before-compaction",
              name: "read_file",
              argumentsJson: JSON.stringify({ path: "prior-missing.txt" }),
            },
          ],
        },
        {
          role: "tool",
          callId: "lazy-image-before-compaction",
          name: "read_file",
          result: {
            status: "failed",
            error: { code: "not_found", message: "The requested path does not exist." },
          },
        },
      ],
      inputResources: [occurrence],
      nextSequence: 1,
      promptContext: createPromptContextV1(tools),
      targetIdentity: {
        targetId: "deepseek-v4-flash-vision-exp.direct",
        vendor: "deepseek",
        modelId: "deepseek-v4-flash-vision-exp",
        route: "direct",
        profileVersion: 2,
        certification: "certified",
      },
    },
  } as ConstructorParameters<typeof AgentSession>[0] & {
    readonly [sessionDurableContext]: unknown;
  });

  await expect(session.run({ text: userText, inputResources: [occurrence] })).resolves.toEqual({
    status: "completed",
    answer: "The image remained visible through compaction.",
  });
  expect({ artifactReads, compactionCalls, ordinaryCalls }).toEqual({
    artifactReads: 2,
    compactionCalls: 1,
    ordinaryCalls: 2,
  });
  expect(
    (await store.read()).find(
      (record) => record.schemaVersion === 3 && record.record.type === "context_compaction_started",
    ),
  ).toMatchObject({
    record: {
      projectedContent: {
        version: 1,
        imageToolResults: {
          count: 1,
          byteCount: imageBytes.byteLength,
          pixelCount: 1,
          maximumWidth: 1,
          maximumHeight: 1,
        },
      },
    },
  });
});

test("SessionLifecycle restarts and branches from one committed context checkpoint", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-context-lifecycle-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "context.txt"), "lifecycle context ".repeat(220), "utf8");
  const lifecycleContextProfile: ContextProfile = {
    ...contextProfile,
    compactAtTokens: 900,
    postCompactTargetTokens: 700,
  };

  let ordinaryCall = 0;
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        yield {
          type: "text_delta",
          text: JSON.stringify({
            schemaVersion: 1,
            objective: "Continue from the durable lifecycle checkpoint.",
            constraints: [],
            progress: ["The parent read context.txt."],
            unresolvedQuestions: [],
            failures: [],
            remainingVerification: [],
            nextSafeAction: "Complete the parent or child request.",
          }),
        };
        yield { type: "usage", inputTokens: 560, outputTokens: 25 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      ordinaryCall += 1;
      if (ordinaryCall === 1) {
        yield { type: "usage", inputTokens: 30, outputTokens: 10 };
        yield { type: "tool_call_start", id: "read-lifecycle", name: "read_file" };
        yield {
          type: "tool_call_delta",
          id: "read-lifecycle",
          json: '{"path":"context.txt"}',
        };
        yield { type: "tool_call_end", id: "read-lifecycle" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      if (ordinaryCall === 2) {
        yield { type: "text_delta", text: "Parent completed after compaction." };
        yield { type: "usage", inputTokens: 100, outputTokens: 10 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      expect(
        request.messages.some(
          (message) => message.role === "developer" && message.content.includes("<context-summary"),
        ),
      ).toBe(true);
      expect(JSON.stringify(request.messages)).not.toContain("lifecycle context lifecycle context");
      yield { type: "text_delta", text: "Child continued from the checkpoint." };
      yield { type: "usage", inputTokens: 80, outputTokens: 10 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile: lifecycleContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "test" },
            contextProfile: lifecycleContextProfile,
          },
        ],
      };
    },
  };
  const lifecycleOptions = {
    modelTargets,
    stateRoot,
    workspaceRoot,
    tools: createReadToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
  };
  const lifecycle = createSessionLifecycle(lifecycleOptions);

  try {
    const created = await lifecycle.create({ targetIdentity });
    const parent = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Read context.txt and complete the parent task." },
    });
    expect(parent.result).toEqual({
      status: "completed",
      answer: "Parent completed after compaction.",
    });
    expect(parent.snapshot).toMatchObject({
      context: {
        checkpoint: { windowNumber: 1, status: "committed" },
        ordinaryUsage: { inputTokens: 130, outputTokens: 20, unknownCalls: 0 },
        compactionUsage: { inputTokens: 560, outputTokens: 25, unknownCalls: 0 },
      },
    });
    expect(JSON.stringify(parent.snapshot)).not.toContain(
      "Continue from the durable lifecycle checkpoint",
    );

    const parentStore = await openJsonlSessionStore({
      stateRoot,
      workspaceRoot,
      sessionId: created.sessionId,
    });
    const checkpoint = (await parentStore.read()).find(
      (record) =>
        record.schemaVersion === 3 && record.record.type === "context_compaction_committed",
    ) as SessionContextCompactionCommittedRecord | undefined;
    expect(checkpoint).toBeDefined();
    const child = await lifecycle.branch({
      parentSessionId: created.sessionId,
      atSequence: checkpoint?.sequence ?? 0,
    });
    expect(child).toMatchObject({
      lineage: { parentSessionId: created.sessionId, parentEventPosition: checkpoint?.sequence },
      context: { checkpoint: { windowNumber: 1, status: "committed" } },
    });

    const restarted = createSessionLifecycle(lifecycleOptions);
    await expect(restarted.resume({ sessionId: created.sessionId })).resolves.toMatchObject({
      status: "ready",
      snapshot: { context: { checkpoint: { windowNumber: 1, status: "committed" } } },
    });
    const recordsBeforeV2Snapshot = await parentStore.read();
    const currentV2Identity = { ...targetIdentity, profileVersion: 2 } as const;
    const upgradedTargets: ModelTargets = {
      async resolve(input) {
        return input.targetIdentity?.profileVersion === 1
          ? { identity: targetIdentity, driver: model, contextProfile: lifecycleContextProfile }
          : {
              identity: currentV2Identity,
              driver: model,
              contextProfile: preparedDirectDeepSeekV2ContextProfile,
            };
      },
      async snapshot(input) {
        const current = {
          identity: currentV2Identity,
          readiness: { status: "available" as const, credentialSource: "test" },
          contextProfile: preparedDirectDeepSeekV2ContextProfile,
        };
        const historical = {
          identity: targetIdentity,
          readiness: { status: "available" as const, credentialSource: "test" },
          contextProfile: lifecycleContextProfile,
        };
        return {
          targets: input.includeHistoricalProfiles ? [current, historical] : [current],
        };
      },
    };
    await expect(
      createSessionLifecycle({ ...lifecycleOptions, modelTargets: upgradedTargets }).resume({
        sessionId: created.sessionId,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      snapshot: {
        targetIdentity,
        context: { profile: lifecycleContextProfile, checkpoint: { windowNumber: 1 } },
      },
    });
    expect(await parentStore.read()).toEqual(recordsBeforeV2Snapshot);
    let incompatibleDriverWasCalled = false;
    const incompatibleProfile: ContextProfile = {
      ...lifecycleContextProfile,
      version: 2,
      compactAtTokens: lifecycleContextProfile.compactAtTokens - 1,
    };
    const incompatibleTargets: ModelTargets = {
      async resolve() {
        incompatibleDriverWasCalled = true;
        return { identity: targetIdentity, driver: model, contextProfile: incompatibleProfile };
      },
      async snapshot() {
        return {
          targets: [
            {
              identity: targetIdentity,
              readiness: { status: "available", credentialSource: "test" },
              contextProfile: incompatibleProfile,
            },
          ],
        };
      },
    };
    await expect(
      createSessionLifecycle({ ...lifecycleOptions, modelTargets: incompatibleTargets }).resume({
        sessionId: created.sessionId,
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "model_target_incompatible" },
    });
    expect(incompatibleDriverWasCalled).toBe(false);
    await expect(
      restarted.continue({ sessionId: child.sessionId, input: { text: "Continue the child." } }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "Child continued from the checkpoint." },
    });

    const parentRecordsBeforeBranches = await parentStore.read();
    const beforeCheckpointChild = await restarted.branch({
      parentSessionId: created.sessionId,
      atSequence: checkpoint?.record.sourceThrough ?? 0,
    });
    const beforeCheckpointContinuation = await restarted.continue({
      sessionId: beforeCheckpointChild.sessionId,
      input: { text: "Continue and compact the child from before the checkpoint." },
    });
    expect(beforeCheckpointContinuation).toMatchObject({
      result: { status: "completed", answer: "Child continued from the checkpoint." },
      snapshot: { context: { checkpoint: { windowNumber: 1, status: "committed" } } },
    });
    const beforeCheckpointChildStore = await openJsonlSessionStore({
      stateRoot,
      workspaceRoot,
      sessionId: beforeCheckpointChild.sessionId,
    });
    expect(
      (await beforeCheckpointChildStore.read()).find(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "context_compaction_committed",
      ),
    ).toMatchObject({
      record: {
        evidence: {
          permissions: [
            expect.objectContaining({
              sessionId: created.sessionId,
              callId: "read-lifecycle",
              decision: "allow",
            }),
          ],
          toolResults: [
            expect.objectContaining({
              sessionId: created.sessionId,
              callId: "read-lifecycle",
              status: "completed",
            }),
          ],
        },
      },
    });

    const afterCheckpointChild = await restarted.branch({
      parentSessionId: created.sessionId,
      atSequence: parent.snapshot.lastSequence,
    });
    await expect(
      restarted.resume({ sessionId: afterCheckpointChild.sessionId }),
    ).resolves.toMatchObject({ status: "ready" });
    const afterCheckpointContinuation = await restarted.continue({
      sessionId: afterCheckpointChild.sessionId,
      input: { text: "Continue the child from after the checkpoint." },
    });
    expect(afterCheckpointContinuation).toMatchObject({
      result: { status: "completed", answer: "Child continued from the checkpoint." },
    });
    const grandchild = await restarted.branch({
      parentSessionId: afterCheckpointChild.sessionId,
      atSequence: afterCheckpointContinuation.snapshot.lastSequence,
    });
    expect(grandchild).toMatchObject({
      lineage: { parentSessionId: afterCheckpointChild.sessionId },
      context: { checkpoint: { windowNumber: 1, status: "committed" } },
    });
    expect(await parentStore.read()).toEqual(parentRecordsBeforeBranches);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle reports then normalizes a dangling compaction attempt after restart", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-context-dangling-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "context.txt"), "dangling context ".repeat(220), "utf8");

  let ordinaryCall = 0;
  let compactionCall = 0;
  const danglingContextProfile = {
    ...contextProfile,
    compactAtTokens: 900,
    postCompactTargetTokens: 700,
  };
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        compactionCall += 1;
        if (compactionCall === 1) {
          throw new Error("simulated process loss during compaction");
        }
        yield {
          type: "text_delta",
          text: JSON.stringify({
            schemaVersion: 1,
            objective: "Continue after the interrupted compaction.",
            constraints: [],
            progress: ["The prior attempt was normalized."],
            unresolvedQuestions: [],
            failures: [],
            remainingVerification: [],
            nextSafeAction: "Complete the ordinary turn.",
          }),
        };
        yield { type: "usage", inputTokens: 500, outputTokens: 20 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      ordinaryCall += 1;
      if (ordinaryCall > 1) {
        yield { type: "text_delta", text: "Cold continuation completed." };
        yield { type: "usage", inputTokens: 80, outputTokens: 10 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      yield { type: "usage", inputTokens: 30, outputTokens: 10 };
      yield { type: "tool_call_start", id: "read-before-loss", name: "read_file" };
      yield { type: "tool_call_delta", id: "read-before-loss", json: '{"path":"context.txt"}' };
      yield { type: "tool_call_end", id: "read-before-loss" };
      yield { type: "finish", reason: "tool_calls" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile: danglingContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "test" },
            contextProfile: danglingContextProfile,
          },
        ],
      };
    },
  };
  const options = {
    modelTargets,
    stateRoot,
    workspaceRoot,
    tools: createReadToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
  };
  const lifecycle = createSessionLifecycle(options);

  try {
    const created = await lifecycle.create({ targetIdentity });
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Read context.txt before the process disappears." },
      }),
    ).rejects.toThrow("simulated process loss during compaction");

    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      status: "interrupted",
      context: {
        lastAttempt: { attemptNumber: 1, status: "started", usage: { status: "unknown" } },
      },
    });
    const restarted = createSessionLifecycle(options);
    await expect(restarted.resume({ sessionId: created.sessionId })).resolves.toMatchObject({
      status: "ready",
      snapshot: {
        status: "interrupted",
        context: {
          lastAttempt: {
            attemptNumber: 1,
            status: "interrupted",
            reason: "process_restart",
            usage: { status: "unknown" },
          },
        },
      },
    });
    await expect(restarted.continue({ sessionId: created.sessionId })).resolves.toMatchObject({
      result: { status: "completed", answer: "Cold continuation completed." },
      snapshot: {
        context: {
          checkpoint: { status: "committed", windowNumber: 1 },
          lastAttempt: { status: "committed", attemptNumber: 2 },
        },
      },
    });
    const records = await openJsonlSessionStore({
      stateRoot,
      workspaceRoot,
      sessionId: created.sessionId,
    });
    expect(
      (await records.read()).filter(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "context_compaction_interrupted",
      ),
    ).toMatchObject([
      {
        record: {
          type: "context_compaction_interrupted",
          reason: "process_restart",
          usage: { status: "unknown" },
        },
      },
    ]);
    expect(
      (await records.read()).filter(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "context_compaction_started",
      ),
    ).toMatchObject([
      { record: { attemptNumber: 1, windowNumber: 1 } },
      { record: { attemptNumber: 2, windowNumber: 1 } },
    ]);
    expect({ ordinaryCall, compactionCall }).toEqual({ ordinaryCall: 2, compactionCall: 2 });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a committed checkpoint whose replacement digest is invalid", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-context-invalid-digest-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const store = await openJsonlSessionStore<SessionRecord>({
      stateRoot,
      workspaceRoot,
      sessionId: created.sessionId,
    });
    const runId = "c0000000-0000-4000-8000-00000000000c";
    const attemptId = "d0000000-0000-4000-8000-00000000000d";
    const checkpointId = "e0000000-0000-4000-8000-00000000000e";
    const summary = {
      schemaVersion: 1,
      objective: "Reject an invalid replacement digest.",
      constraints: [],
      progress: [],
      unresolvedQuestions: [],
      failures: [],
      remainingVerification: [],
      nextSafeAction: "Do not dispatch a model or effect.",
    } as const;
    const sourceDigest = digestContextRecordPrefix([
      {
        schemaVersion: 3,
        sequence: 1,
        record: {
          type: "session_genesis",
          sessionId: created.sessionId,
          projectId: created.projectId,
          targetIdentity,
        },
      },
      {
        schemaVersion: 3,
        sequence: 2,
        record: { type: "logical_run_started", runId, userMessage: "Validate the checkpoint." },
      },
      {
        schemaVersion: 3,
        sequence: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Validate the checkpoint." },
        },
      },
    ]);
    const evidence = {
      schemaVersion: 1,
      modifiedFiles: [],
      permissions: [],
      toolResults: [],
      failures: [],
    } as const;
    const records: SessionRecord[] = [
      {
        schemaVersion: 3,
        sequence: 2,
        record: { type: "logical_run_started", runId, userMessage: "Validate the checkpoint." },
      },
      {
        schemaVersion: 3,
        sequence: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Validate the checkpoint." },
        },
      },
      {
        schemaVersion: 3,
        sequence: 4,
        record: {
          type: "context_compaction_started",
          recordVersion: 1,
          runId,
          attemptId,
          attemptNumber: 1,
          windowNumber: 1,
          trigger: "automatic_threshold",
          sourceThrough: 3,
          targetIdentity,
          contextProfile,
          projectionVersion: 1,
          sourceDigest,
        },
      },
      {
        schemaVersion: 3,
        sequence: 5,
        record: {
          type: "context_compaction_committed",
          recordVersion: 1,
          runId,
          attemptId,
          attemptNumber: 1,
          checkpointId,
          windowNumber: 1,
          trigger: "automatic_threshold",
          sourceThrough: 3,
          retainedFrom: 4,
          targetIdentity,
          contextProfile,
          projectionVersion: 1,
          sourceDigest,
          replacementDigest: `sha256:${"0".repeat(64)}`,
          summary,
          evidence,
          usage: { inputTokens: 20, outputTokens: 5 },
        },
      },
    ];
    for (const record of records) {
      await store.append(record);
    }

    await expect(lifecycle.inspect({ sessionId: created.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});
