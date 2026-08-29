import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ContextProfile,
  createCodingToolRegistry,
  createModelTargets,
  createMutationToolRegistry,
  createPermissionPolicy,
  createReadToolRegistry,
  type LocalInputResourceSelectionV1,
  type ModelDriver,
  type ModelMessage,
  type ModelTargetIdentity,
  type ModelTargets,
  type ModelToolDefinition,
  type RuntimeEvent,
  resolveThinkingPolicy,
  type ThinkingPolicySelectionV1,
} from "@adam-agent/agent";
import {
  createInMemorySessionStoreDirectory,
  inputResourceIngestBarrier,
  openJsonlSessionStore,
  type ProjectLifecycleOwner,
  ProjectLifecycleOwnerError,
  preparedDirectDeepSeekV2ContextProfile,
  type SessionRecord,
  type SessionStoreDirectory,
  sessionAutomaticTitlesEnabled,
  sessionCloseDrainBarrier,
  sessionLogicalRunStartedBarrier,
  sessionProjectLifecycleOwner,
  sessionStoreDirectory,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { createInMemorySessionLifecycleHarness, FakeModelDriver } from "./index.js";
import {
  sessionLifecycleAnswerOnlyDeepSeekStream as answerOnlyDeepSeekStream,
  sessionLifecycleBasePrompt as basePrompt,
  createSessionLifecycleForTests as createSessionLifecycle,
  sessionLifecycleSkillUsagePrompt as skillUsagePrompt,
  sessionLifecycleTargetIdentity as targetIdentity,
} from "./session-lifecycle.test-support.js";

const testContextProfile: ContextProfile = {
  version: 1,
  contextWindowTokens: 1_000_000,
  maximumOutputTokens: 32_768,
  compactAtTokens: 800_000,
  postCompactTargetTokens: 200_000,
  retainedTargetTokens: 20_000,
  estimatorVersion: 1,
};

function thinkingSelection(
  capability: {
    readonly capabilityId: string;
    readonly capabilityVersion: 1;
    readonly capabilityDigest: `sha256:${string}`;
  },
  requestedLevelId: string,
): ThinkingPolicySelectionV1 {
  return {
    requestedLevelId,
    capability: {
      id: capability.capabilityId,
      version: capability.capabilityVersion,
      digest: capability.capabilityDigest,
    },
  };
}
const codingToolDefinitions = createCodingToolRegistry({
  workspaceRoot: "/tmp/adam-agent-session-lifecycle-tool-definitions",
}).definitions();

function promptProjectionFor(
  snapshot: {
    readonly promptContext?: {
      readonly assemblyIdentityDigest: `sha256:${string}`;
      readonly profileVersion: 1 | 2 | 3;
    };
  },
  transcript: string | readonly ModelMessage[],
  tools?: readonly ModelToolDefinition[],
): {
  readonly version: 1;
  readonly assemblyIdentityDigest: `sha256:${string}`;
  readonly requestProjectionDigest: `sha256:${string}`;
} {
  const assemblyIdentityDigest = snapshot.promptContext?.assemblyIdentityDigest;
  if (assemblyIdentityDigest === undefined) {
    throw new Error("The fixture requires a v1 prompt context.");
  }
  return {
    version: 1 as const,
    assemblyIdentityDigest,
    requestProjectionDigest: `sha256:${createHash("sha256")
      .update(
        canonicalFixtureJson({
          version: 1,
          messages: [
            { role: "system", content: basePrompt },
            ...(snapshot.promptContext !== undefined && snapshot.promptContext.profileVersion !== 1
              ? [{ role: "developer" as const, content: skillUsagePrompt }]
              : []),
            ...(typeof transcript === "string"
              ? [{ role: "user" as const, content: transcript }]
              : transcript),
          ],
          tools:
            tools ??
            (snapshot.promptContext !== undefined && snapshot.promptContext.profileVersion !== 1
              ? codingToolDefinitions
              : []),
        }),
      )
      .digest("hex")}`,
  };
}

test("session metadata observers cannot overturn a durable naming mutation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-metadata-observer-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    stateRoot,
    workspaceRoot,
  });
  const releaseObserver = Promise.withResolvers<void>();
  const unsubscribeFailure = lifecycle.subscribeMetadata(() => {
    throw new Error("observer failed");
  });
  const unsubscribePending = lifecycle.subscribeMetadata(() => releaseObserver.promise);
  let failureGuard: ReturnType<typeof setTimeout> | undefined;

  try {
    const created = await lifecycle.create({ targetIdentity });
    const naming = lifecycle.setSessionManualName({
      sessionId: created.sessionId,
      name: "Durable name",
    });
    await expect(
      Promise.race([
        naming,
        new Promise<never>((_resolve, reject) => {
          failureGuard = setTimeout(
            () => reject(new Error("A metadata observer blocked durable naming.")),
            1_000,
          );
        }),
      ]),
    ).resolves.toMatchObject({ status: "updated" });
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      lastSequence: 2,
    });
  } finally {
    if (failureGuard !== undefined) {
      clearTimeout(failureGuard);
    }
    releaseObserver.resolve();
    unsubscribeFailure();
    unsubscribePending();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle close causally joins an admitted naming mutation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-naming-close-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    stateRoot,
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const naming = lifecycle.setSessionManualName({
      sessionId: created.sessionId,
      name: "Durable close name",
    });
    const closing = lifecycle.close();

    await expect(naming).resolves.toMatchObject({ status: "updated" });
    await expect(closing).resolves.toEqual({ status: "closed" });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle close drains every admitted owner operation after acquisition reorder", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-owner-drain-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const firstAcquisitionStarted = Promise.withResolvers<void>();
  const releaseFirstAcquisition = Promise.withResolvers<void>();
  const secondAcquisitionStarted = Promise.withResolvers<void>();
  const releaseSecondAcquisition = Promise.withResolvers<void>();
  let reorderAcquisitions = false;
  let reorderedRun = 0;
  let secondAcquisitionHeld = false;
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      if (!reorderAcquisitions) {
        return operation();
      }
      reorderedRun += 1;
      if (reorderedRun === 1) {
        firstAcquisitionStarted.resolve();
        await releaseFirstAcquisition.promise;
        throw new ProjectLifecycleOwnerError("project_in_use");
      }
      if (reorderedRun === 2) {
        secondAcquisitionHeld = true;
        secondAcquisitionStarted.resolve();
        try {
          const result = await operation();
          await releaseSecondAcquisition.promise;
          return result;
        } finally {
          secondAcquisitionHeld = false;
        }
      }
      if (secondAcquisitionHeld) {
        releaseSecondAcquisition.resolve();
        throw new ProjectLifecycleOwnerError("project_in_use");
      }
      return operation();
    },
  };
  const drainedCounts: number[] = [];
  const lifecycle = createSessionLifecycle({
    stateRoot,
    workspaceRoot,
    [sessionCloseDrainBarrier]: {
      beforeWait({ activeCount }) {
        drainedCounts.push(activeCount);
        releaseSecondAcquisition.resolve();
      },
    },
    [sessionProjectLifecycleOwner]: owner,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    reorderAcquisitions = true;
    const firstNaming = lifecycle.setSessionManualName({
      sessionId: created.sessionId,
      name: "Rejected first acquisition",
    });
    await firstAcquisitionStarted.promise;
    const secondNaming = lifecycle.setSessionManualName({
      sessionId: created.sessionId,
      name: "Durable reordered acquisition",
    });
    await secondAcquisitionStarted.promise;
    releaseFirstAcquisition.resolve();
    await expect(firstNaming).rejects.toMatchObject({ code: "project_in_use" });
    const closing = lifecycle.close();

    await expect(secondNaming).resolves.toMatchObject({ status: "updated" });
    await expect(closing).resolves.toEqual({ status: "closed" });
    expect(drainedCounts).toEqual([1]);
  } finally {
    releaseFirstAcquisition.resolve();
    releaseSecondAcquisition.resolve();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle close joins title admission before returning", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-title-close-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const heldOwnerOperation = Promise.withResolvers<void>();
  const releaseOwnerOperation = Promise.withResolvers<void>();
  const titleRequestStarted = Promise.withResolvers<void>();
  const releaseTitleRequest = Promise.withResolvers<void>();
  const titleDrainStarted = Promise.withResolvers<void>();
  const closeDurabilityStarted = Promise.withResolvers<void>();
  let holdNextOwnerOperation = false;
  let observeCloseDurability = false;
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      const hold = holdNextOwnerOperation;
      holdNextOwnerOperation = false;
      if (observeCloseDurability && !hold) {
        closeDurabilityStarted.resolve();
      }
      const result = await operation();
      if (hold) {
        heldOwnerOperation.resolve();
        await releaseOwnerOperation.promise;
      }
      return result;
    },
  };
  const closeOrder: string[] = [];
  const model: ModelDriver = {
    async *stream(request) {
      if (request.purpose === "title") {
        closeOrder.push("title-started");
        titleRequestStarted.resolve();
        await releaseTitleRequest.promise;
        yield { type: "text_delta", text: "Joined generated title" };
        yield { type: "finish", reason: "stop" };
        return;
      }
      yield { type: "text_delta", text: "Ordinary answer." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    [sessionCloseDrainBarrier]: {
      beforeWait({ kind }) {
        if (kind === "owner") {
          releaseOwnerOperation.resolve();
        } else if (kind === "title_settlement") {
          titleDrainStarted.resolve();
        }
      },
    },
    [sessionProjectLifecycleOwner]: owner,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Create title history" },
    });
    holdNextOwnerOperation = true;
    const regeneration = lifecycle.regenerateSessionTitle({ sessionId: created.sessionId });
    await heldOwnerOperation.promise;
    observeCloseDurability = true;
    const closing = lifecycle.close().then((result) => {
      closeOrder.push("closed");
      return result;
    });
    const firstClosePath = Promise.race([
      titleDrainStarted.promise.then(() => "title-drain" as const),
      closeDurabilityStarted.promise.then(() => "close-durability" as const),
    ]).then((path) => {
      releaseTitleRequest.resolve();
      return path;
    });

    await titleRequestStarted.promise;
    await expect(firstClosePath).resolves.toBe("title-drain");
    await expect(regeneration).resolves.toMatchObject({ status: "updated" });
    await expect(closing).resolves.toEqual({ status: "closed" });
    expect(closeOrder).toEqual(["title-started", "closed"]);
  } finally {
    releaseOwnerOperation.resolve();
    releaseTitleRequest.resolve();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

function canonicalFixtureJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalFixtureJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalFixtureJson(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError("Fixture canonical JSON requires a JSON value.");
}

function snapshotWithLastPromptProjection<Snapshot extends { readonly promptContext?: object }>(
  snapshot: Snapshot,
  digest: `sha256:${string}`,
) {
  if (snapshot.promptContext === undefined) {
    throw new Error("The fixture requires a v1 prompt context.");
  }
  return {
    ...snapshot,
    promptContext: { ...snapshot.promptContext, lastRequestProjectionDigest: digest },
  };
}

const introductionRequestDigest =
  "sha256:0782707796dafcb2988d1eadadddc3de09e48ef4a1760ab57a4be9a983b9a181" as const;
const permissionRequestDigest =
  "sha256:341baabb2a66d516430fc49f39c3c408a15dae8a47608ad543a3bb888431b01c" as const;

test("SessionLifecycle rejects a deterministic competing owner and proceeds after release", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-memory-owner-"));
  const workspaceRoot = join(testRoot, "workspace");
  const workspaceAlias = join(testRoot, "workspace-alias");
  await mkdir(workspaceRoot);
  await symlink(workspaceRoot, workspaceAlias, "dir");
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ workspaceRoot });
  const aliasLifecycle = harness.createLifecycle({ workspaceRoot: workspaceAlias });
  const competingOwner = await harness.acquireOwner();

  try {
    await expect(aliasLifecycle.create({ targetIdentity })).rejects.toMatchObject({
      code: "project_in_use",
    });
    await competingOwner.release();

    await expect(aliasLifecycle.create({ targetIdentity })).resolves.toMatchObject({
      status: "idle",
      targetIdentity,
    });
  } finally {
    await competingOwner.release();
    await aliasLifecycle.close();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle creates durable new-schema genesis for an exact project and target", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-create-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);

  const harness = createInMemorySessionLifecycleHarness();
  const first = harness.createLifecycle({ stateRoot, workspaceRoot });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;

  try {
    const created = await first.create({ targetIdentity });
    await expect(first.close()).resolves.toEqual({ status: "closed" });
    const coldLifecycle = harness.createLifecycle({ stateRoot, workspaceRoot });
    cold = coldLifecycle;
    const inspected = await coldLifecycle.inspect({ sessionId: created.sessionId });

    const expected = {
      schemaVersion: 3,
      sessionId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
      projectId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      targetIdentity,
      status: "idle",
      lastSequence: 1,
      promptContext: created.promptContext,
      skillContext: created.skillContext,
    };
    expect({ created, inspected }).toEqual({ created: expected, inspected: expected });
    await expect(stat(join(stateRoot, "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await first.close();
    await cold?.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle snapshots one thinking policy and reuses it across tool continuations", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-thinking-policy-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "# Adam\n", "utf8");
  const policyTargetIdentity: ModelTargetIdentity = {
    ...targetIdentity,
    profileVersion: 3,
  };
  const productionTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
  });
  const productionSnapshot = await productionTargets.snapshot({
    signal: new AbortController().signal,
  });
  const thinkingCapability = productionSnapshot.targets.find(
    (target) =>
      target.identity.targetId === policyTargetIdentity.targetId &&
      target.identity.profileVersion === policyTargetIdentity.profileVersion,
  )?.thinkingCapability;
  if (thinkingCapability === undefined) {
    throw new Error("Expected the exact Direct DeepSeek thinking capability.");
  }
  const requestPolicies: unknown[] = [];
  let requestCount = 0;
  const driver = new FakeModelDriver((request) => {
    requestPolicies.push(request.thinkingPolicy);
    requestCount += 1;
    return requestCount === 1
      ? [
          { type: "tool_call_start", id: "read-project", name: "read_file" },
          { type: "tool_call_delta", id: "read-project", json: '{"path":"README.md"}' },
          { type: "tool_call_end", id: "read-project" },
          { type: "finish", reason: "tool_calls" },
        ]
      : [
          { type: "text_delta", text: "The project is Adam." },
          { type: "finish", reason: "stop" },
        ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: policyTargetIdentity,
        driver,
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
        thinkingCapability,
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: policyTargetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
            thinkingCapability,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    tools: createReadToolRegistry({ workspaceRoot }),
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity: policyTargetIdentity });
    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Read the project name." },
      thinkingSelection: thinkingSelection(thinkingCapability, "max"),
    });

    expect(continued.result).toEqual({ status: "completed", answer: "The project is Adam." });
    expect(requestPolicies).toHaveLength(2);
    expect(requestPolicies[0]).toEqual(requestPolicies[1]);
    expect(requestPolicies[0]).toMatchObject({
      schemaVersion: 1,
      requestedLevelId: "max",
      effectiveLevelId: "max",
      capability: {
        id: thinkingCapability.capabilityId,
        version: 1,
        digest: thinkingCapability.capabilityDigest,
      },
      mapping: {
        requestPath: "provider_options.deepseek",
        thinkingType: "enabled",
        reasoningEffort: "max",
      },
    });
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the admitted session store.");
    }
    expect(await store.read()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record: expect.objectContaining({
            type: "logical_run_started",
            thinkingPolicy: requestPolicies[0],
          }),
        }),
      ]),
    );
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects an unsupported thinking level before draft persistence or provider dispatch", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-thinking-rejection-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const policyTargetIdentity: ModelTargetIdentity = { ...targetIdentity, profileVersion: 3 };
  const productionTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
  });
  const productionSnapshot = await productionTargets.snapshot({
    signal: new AbortController().signal,
  });
  const thinkingCapability = productionSnapshot.targets.find(
    (target) =>
      target.identity.targetId === policyTargetIdentity.targetId &&
      target.identity.profileVersion === policyTargetIdentity.profileVersion,
  )?.thinkingCapability;
  if (thinkingCapability === undefined) {
    throw new Error("Expected the exact Direct DeepSeek thinking capability.");
  }
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return [{ type: "finish", reason: "stop" }];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: policyTargetIdentity,
        driver,
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
        thinkingCapability,
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: policyTargetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
            thinkingCapability,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity: policyTargetIdentity,
        input: { text: "Do not downgrade this request." },
        thinkingSelection: thinkingSelection(thinkingCapability, "medium"),
      }),
    ).rejects.toMatchObject({
      code: "session_thinking_policy_unsupported",
      supportedLevelIds: ["off", "low", "high", "max"],
    });
    expect(providerCalls).toBe(0);
    await expect(harness.sessions.listSessionIds()).resolves.toEqual([]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a thinking capability minted for another exact target before admission", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-thinking-target-mismatch-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const policyTargetIdentity: ModelTargetIdentity = { ...targetIdentity, profileVersion: 3 };
  const productionTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
  });
  const productionSnapshot = await productionTargets.snapshot({
    signal: new AbortController().signal,
  });
  const mismatchedCapability = productionSnapshot.targets.find(
    (target) =>
      target.identity.targetId === "deepseek-v4-pro.direct" &&
      target.identity.profileVersion === policyTargetIdentity.profileVersion,
  )?.thinkingCapability;
  if (mismatchedCapability === undefined) {
    throw new Error("Expected the alternate Direct DeepSeek thinking capability.");
  }
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return [{ type: "finish", reason: "stop" }];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: policyTargetIdentity,
        driver,
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
        thinkingCapability: mismatchedCapability,
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: policyTargetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
            thinkingCapability: mismatchedCapability,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity: policyTargetIdentity,
        input: { text: "Reject the wrong exact-target capability." },
        thinkingSelection: thinkingSelection(mismatchedCapability, "low"),
      }),
    ).rejects.toMatchObject({
      code: "session_thinking_policy_unsupported",
      supportedLevelIds: ["off", "low", "high", "max"],
    });
    expect(providerCalls).toBe(0);
    await expect(harness.sessions.listSessionIds()).resolves.toEqual([]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle cold recovery reuses the durable thinking snapshot without remapping it", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-thinking-recovery-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const policyTargetIdentity: ModelTargetIdentity = { ...targetIdentity, profileVersion: 3 };
  const productionTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
  });
  const productionSnapshot = await productionTargets.snapshot({
    signal: new AbortController().signal,
  });
  const thinkingCapability = productionSnapshot.targets.find(
    (target) =>
      target.identity.targetId === policyTargetIdentity.targetId &&
      target.identity.profileVersion === policyTargetIdentity.profileVersion,
  )?.thinkingCapability;
  if (thinkingCapability === undefined) {
    throw new Error("Expected the exact Direct DeepSeek thinking capability.");
  }
  const durablePolicy = resolveThinkingPolicy(thinkingCapability, "low");
  const requestPolicies: unknown[] = [];
  const driver = new FakeModelDriver((request) => {
    requestPolicies.push(request.thinkingPolicy);
    return [
      { type: "text_delta", text: "Recovered with the original policy." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: policyTargetIdentity,
        driver,
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
        thinkingCapability,
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: policyTargetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
            thinkingCapability,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const warm = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
  let cold: typeof warm | undefined;

  try {
    const created = await warm.create({ targetIdentity: policyTargetIdentity });
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const runId = "123e4567-e89b-42d3-a456-426614174091";
    await store.append({
      schemaVersion: 3,
      sequence: 2,
      record: {
        type: "logical_run_started",
        runId,
        userMessage: "Recover this exact policy",
        thinkingPolicy: durablePolicy,
      },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 3,
      record: {
        type: "runtime_event",
        runId,
        event: { type: "user_message", text: "Recover this exact policy" },
      },
    });
    await warm.close();
    cold = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

    await expect(cold.resume({ sessionId: created.sessionId })).resolves.toMatchObject({
      status: "ready",
      snapshot: { status: "interrupted" },
    });
    await expect(cold.continue({ sessionId: created.sessionId })).resolves.toMatchObject({
      result: { status: "completed", answer: "Recovered with the original policy." },
    });
    expect(requestPolicies).toEqual([durablePolicy]);
  } finally {
    await warm.close();
    await cold?.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a stale durable thinking profile before recovery dispatch", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-thinking-stale-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const policyTargetIdentity: ModelTargetIdentity = { ...targetIdentity, profileVersion: 3 };
  const productionTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
  });
  const productionSnapshot = await productionTargets.snapshot({
    signal: new AbortController().signal,
  });
  const thinkingCapability = productionSnapshot.targets.find(
    (target) =>
      target.identity.targetId === policyTargetIdentity.targetId &&
      target.identity.profileVersion === policyTargetIdentity.profileVersion,
  )?.thinkingCapability;
  if (thinkingCapability === undefined) {
    throw new Error("Expected the exact Direct DeepSeek thinking capability.");
  }
  const durablePolicy = resolveThinkingPolicy(thinkingCapability, "low");
  const staleCapability = {
    ...thinkingCapability,
    capabilityDigest: `sha256:${"0".repeat(64)}` as const,
  };
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return [{ type: "finish", reason: "stop" }];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: policyTargetIdentity,
        driver,
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
        thinkingCapability: staleCapability,
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: policyTargetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
            thinkingCapability: staleCapability,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const created = await lifecycle.create({ targetIdentity: policyTargetIdentity });
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const runId = "123e4567-e89b-42d3-a456-426614174092";
    await store.append({
      schemaVersion: 3,
      sequence: 2,
      record: {
        type: "logical_run_started",
        runId,
        userMessage: "Reject a stale profile",
        thinkingPolicy: durablePolicy,
      },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 3,
      record: {
        type: "runtime_event",
        runId,
        event: { type: "user_message", text: "Reject a stale profile" },
      },
    });

    await expect(lifecycle.resume({ sessionId: created.sessionId })).resolves.toMatchObject({
      status: "ready",
      snapshot: { status: "interrupted" },
    });
    await expect(lifecycle.continue({ sessionId: created.sessionId })).rejects.toMatchObject({
      code: "session_thinking_policy_unsupported",
      supportedLevelIds: ["off", "low", "high", "max"],
    });
    expect(providerCalls).toBe(0);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects an unavailable draft Skill before allocating durable session identity", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-draft-skill-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const skillDirectory = join(workspaceRoot, ".agents", "skills", "available-sibling");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: available-sibling\ndescription: Proves rejected admission leaves discovered Skills staged.\n---\nDo not persist this sibling before admission.\n",
    "utf8",
  );
  const harness = createInMemorySessionLifecycleHarness();
  const driver = new FakeModelDriver(() => {
    throw new Error("The model must not run when draft Skill resolution fails.");
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Use a missing Skill", skills: ["skill:v1:user:missing"] },
      }),
    ).rejects.toMatchObject({ code: "session_skill_unavailable" });
    await expect(harness.sessions.listSessionIds()).resolves.toEqual([]);
    await expect(stat(join(stateRoot, "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects denied draft Skill policy before allocating durable session identity", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-draft-policy-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const skillDirectory = join(workspaceRoot, ".agents", "skills", "draft-policy");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: draft-policy\ndescription: Exercises draft admission policy.\n---\nUse only after read permission is admitted.\n",
    "utf8",
  );
  const harness = createInMemorySessionLifecycleHarness();
  const driver = new FakeModelDriver(() => {
    throw new Error("The model must not run when draft Skill policy denies admission.");
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = harness.createLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: [] }),
    stateRoot,
    workspaceRoot,
  });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: {
          text: "Use the policy Skill",
          skills: ["skill:v1:project:.:draft-policy"],
        },
      }),
    ).rejects.toMatchObject({ code: "session_skill_policy_rejected" });
    await expect(harness.sessions.listSessionIds()).resolves.toEqual([]);
    await expect(stat(join(stateRoot, "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects asked draft Skill policy before allocating durable session identity", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-draft-ask-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const skillDirectory = join(workspaceRoot, ".agents", "skills", "draft-ask");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: draft-ask\ndescription: Requires confirmation before admission.\n---\nDo not admit this draft before confirmation.\n",
    "utf8",
  );
  const harness = createInMemorySessionLifecycleHarness();
  const driver = new FakeModelDriver(() => {
    throw new Error("The model must not run when draft Skill policy needs confirmation.");
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = harness.createLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["read"] }),
    stateRoot,
    workspaceRoot,
  });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Use the asked Skill", skills: ["skill:v1:project:.:draft-ask"] },
      }),
    ).rejects.toMatchObject({ code: "session_skill_confirmation_required" });
    await expect(harness.sessions.listSessionIds()).resolves.toEqual([]);
    await expect(stat(join(stateRoot, "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle cancels after target resolution before persisting draft resources", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-draft-cancel-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const skillDirectory = join(workspaceRoot, ".agents", "skills", "draft-cancel");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: draft-cancel\ndescription: Must remain staged when admission is cancelled.\n---\nNever persist this cancelled draft.\n",
    "utf8",
  );
  const harness = createInMemorySessionLifecycleHarness();
  const controller = new AbortController();
  const modelTargets: ModelTargets = {
    async resolve() {
      controller.abort();
      return {
        identity: targetIdentity,
        driver: new FakeModelDriver(() => {
          throw new Error("The model must not run after draft admission cancellation.");
        }),
        contextProfile: testContextProfile,
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = harness.createLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    workspaceRoot,
  });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: {
          text: "Cancel after resolving the target",
          skills: ["skill:v1:project:.:draft-cancel"],
        },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(harness.sessions.listSessionIds()).resolves.toEqual([]);
    await expect(stat(join(stateRoot, "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle freezes draft Skill resources before allocating durable session identity", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-draft-resource-"));
  const workspaceRoot = join(testRoot, "workspace");
  const skillDirectory = join(workspaceRoot, ".agents", "skills", "draft-resource");
  const resourcePath = join(skillDirectory, "references", "guide.txt");
  await mkdir(join(skillDirectory, "references"), { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: draft-resource\ndescription: Freezes resources before admission.\n---\nRead references/guide.txt.\n",
    "utf8",
  );
  await writeFile(resourcePath, "before admission\n", "utf8");
  const originalSize = (await stat(resourcePath, { bigint: true })).size.toString();
  const harness = createInMemorySessionLifecycleHarness();
  const driver = new FakeModelDriver(() => [
    { type: "text_delta", text: "Draft resource admitted." },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  let policyDecision: "allow" | "deny" = "allow";
  const lifecycle = harness.createLifecycle({
    modelTargets,
    permissions: {
      decide() {
        return policyDecision;
      },
    },
    workspaceRoot,
    [sessionLogicalRunStartedBarrier]: {
      async afterDurableRecord() {
        await writeFile(resourcePath, "changed after durable logical input\n", "utf8");
        policyDecision = "deny";
      },
    },
  });

  try {
    const admitted = await lifecycle.admit({
      targetIdentity,
      input: {
        text: "Use the frozen resource Skill",
        skills: ["skill:v1:project:.:draft-resource"],
      },
    });
    const manifestEntry = admitted.snapshot.skillContext?.active[0]?.manifest.entries.find(
      (entry) => entry.path === "references/guide.txt",
    );

    expect(admitted.result).toMatchObject({ status: "completed" });
    expect(manifestEntry?.identity.size).toBe(originalSize);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle commits one selected input resource before its descriptor reaches the model", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-input-resource-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "Aurora notes.txt");
  const content = "Aurora Compass is ready.\n";
  const bytes = Buffer.from(content, "utf8");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
  const artifactId = digest;
  const runId = "10000000-0000-4000-8000-000000000011";
  const occurrenceId = `${runId}:input:1`;
  const descriptor = {
    occurrenceId,
    displayName: "Aurora notes.txt",
    artifact: {
      id: artifactId,
      mediaType: "text/plain; charset=utf-8",
      byteCount: bytes.byteLength,
    },
    digest,
    mediaHint: "text" as const,
    provenance: "user_local_file" as const,
    support: "utf8_text" as const,
    mode: "link" as const,
  };
  const descriptorProjection = `Linked input resources (descriptor-only; use read_input_resource to read supported immutable content):\n${JSON.stringify([descriptor])}`;
  const pageDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, bytes);
  const harness = createInMemorySessionLifecycleHarness();
  let durableCommitSettled = false;
  let providerCalls = 0;
  const driver = new FakeModelDriver((request) => {
    providerCalls += 1;
    expect(durableCommitSettled).toBe(true);
    if (providerCalls === 1) {
      expect(request.messages.at(-1)).toEqual({
        role: "user",
        content: `Read the linked note.\n\n${descriptorProjection}`,
      });
      expect(request.tools.map((tool) => tool.name)).toContain("read_input_resource");
      return [
        { type: "tool_call_start", id: "resource-call-1", name: "read_input_resource" },
        {
          type: "tool_call_delta",
          id: "resource-call-1",
          json: JSON.stringify({ occurrenceId, maxByteCount: 64 }),
        },
        { type: "tool_call_end", id: "resource-call-1" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    expect(request.messages.at(-1)).toEqual({
      role: "tool",
      callId: "resource-call-1",
      name: "read_input_resource",
      result: {
        status: "completed",
        output: {
          occurrenceId,
          displayName: "Aurora notes.txt",
          offset: 0,
          byteCount: bytes.byteLength,
          totalByteCount: bytes.byteLength,
          eof: true,
          nextCursor: null,
          digest,
          pageDigest,
          content,
        },
      },
    });
    return [
      { type: "text_delta", text: "The linked note says Aurora Compass is ready." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = harness.createLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    [sessionLogicalRunStartedBarrier]: {
      async afterDurableRecord(started) {
        const store = await harness.sessions.open(started.sessionId);
        if (store === undefined) {
          throw new Error("Expected the admitted input-resource session store.");
        }
        expect(await store.read()).toEqual(
          expect.arrayContaining([
            {
              schemaVersion: 3,
              sequence: started.sequence,
              record: {
                type: "logical_run_started",
                recordVersion: 1,
                runId,
                userMessage: "Read the linked note.",
                naming: {
                  profileVersion: 1,
                  fallbackTitle: "Read the linked note.",
                },
                inputResources: [descriptor],
              },
            },
          ]),
        );
        await expect(
          readFile(join(stateRoot, "artifacts", artifactId.slice("sha256:".length))),
        ).resolves.toEqual(bytes);
        durableCommitSettled = true;
      },
    },
  });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Read the linked note." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
        runId,
      }),
    ).resolves.toMatchObject({
      result: {
        status: "completed",
        answer: "The linked note says Aurora Compass is ready.",
      },
    });
    expect(providerCalls).toBe(2);
    const store = await harness.sessions.open(
      (await harness.sessions.listSessionIds())[0] as string,
    );
    expect(await store?.read()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record: {
            type: "input_resource_read_committed",
            recordVersion: 1,
            runId,
            callId: "resource-call-1",
            occurrenceId,
            displayName: "Aurora notes.txt",
            offset: 0,
            byteCount: bytes.byteLength,
            totalByteCount: bytes.byteLength,
            eof: true,
            nextCursor: null,
            digest,
            pageDigest,
            content,
          },
        }),
      ]),
    );
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle follows a stable byte cursor across strict UTF-8 input-resource pages", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-input-resource-pages-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "multibyte.txt");
  const content = "A界BC好D";
  const runId = "10000000-0000-4000-8000-000000000012";
  const occurrenceId = `${runId}:input:1`;
  const cursor = `input-resource:v1:${Buffer.from(JSON.stringify([occurrenceId, 5]), "utf8").toString("base64url")}`;
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, content, "utf8");
  let providerCalls = 0;
  const driver = new FakeModelDriver((request) => {
    providerCalls += 1;
    if (providerCalls === 1) {
      return [
        { type: "tool_call_start", id: "page-1", name: "read_input_resource" },
        {
          type: "tool_call_delta",
          id: "page-1",
          json: JSON.stringify({ occurrenceId, maxByteCount: 5 }),
        },
        { type: "tool_call_end", id: "page-1" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    if (providerCalls === 2) {
      expect(request.messages.at(-1)).toMatchObject({
        role: "tool",
        callId: "page-1",
        result: {
          status: "completed",
          output: {
            occurrenceId,
            offset: 0,
            byteCount: 5,
            totalByteCount: 10,
            eof: false,
            nextCursor: cursor,
            content: "A界B",
          },
        },
      });
      return [
        { type: "tool_call_start", id: "page-2", name: "read_input_resource" },
        {
          type: "tool_call_delta",
          id: "page-2",
          json: JSON.stringify({ occurrenceId, cursor, maxByteCount: 5 }),
        },
        { type: "tool_call_end", id: "page-2" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    expect(request.messages.at(-1)).toMatchObject({
      role: "tool",
      callId: "page-2",
      result: {
        status: "completed",
        output: {
          occurrenceId,
          offset: 5,
          byteCount: 5,
          totalByteCount: 10,
          eof: true,
          nextCursor: null,
          content: "C好D",
        },
      },
    });
    return [
      { type: "text_delta", text: "Both pages were stable." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Read both byte pages." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
        runId,
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "Both pages were stable." },
    });
    expect(providerCalls).toBe(3);
    const store = await harness.sessions.open(
      (await harness.sessions.listSessionIds())[0] as string,
    );
    expect(
      (await store?.read())?.filter(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "input_resource_read_committed",
      ),
    ).toMatchObject([
      { record: { callId: "page-1", offset: 0, byteCount: 5, nextCursor: cursor } },
      { record: { callId: "page-2", offset: 5, byteCount: 5, nextCursor: null } },
    ]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle enforces the exact one MiB materialized-output budget per run", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-input-resource-quota-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "quota.txt");
  const content = "q".repeat(64 * 1024);
  const runId = "10000000-0000-4000-8000-000000000013";
  const occurrenceId = `${runId}:input:1`;
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, content, "utf8");
  let providerCalls = 0;
  const driver = new FakeModelDriver((request) => {
    providerCalls += 1;
    if (providerCalls === 1) {
      return [
        ...Array.from({ length: 17 }, (_, index) => {
          const callId = `quota-${index + 1}`;
          return [
            { type: "tool_call_start" as const, id: callId, name: "read_input_resource" },
            {
              type: "tool_call_delta" as const,
              id: callId,
              json: JSON.stringify({ occurrenceId, maxByteCount: 64 * 1024 }),
            },
            { type: "tool_call_end" as const, id: callId },
          ];
        }).flat(),
        { type: "finish" as const, reason: "tool_calls" as const },
      ];
    }
    const toolMessages = request.messages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(17);
    expect(toolMessages.at(-1)).toEqual({
      role: "tool",
      callId: "quota-17",
      name: "read_input_resource",
      result: {
        status: "failed",
        error: {
          code: "input_resource_quota_exceeded",
          message:
            "The input-resource materialization quota for this run or session lineage would be exceeded.",
        },
      },
    });
    return [
      { type: "text_delta", text: "The seventeenth page was rejected." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Exercise the exact materialized-output budget." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
        runId,
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "The seventeenth page was rejected." },
    });
    const store = await harness.sessions.open(
      (await harness.sessions.listSessionIds())[0] as string,
    );
    expect(
      (await store?.read())?.filter(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "input_resource_read_committed",
      ),
    ).toHaveLength(16);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle enforces the exact eight MiB materialized-output budget per lineage", async () => {
  const testRoot = await mkdtemp(
    join(tmpdir(), "adam-agent-session-input-resource-lineage-quota-"),
  );
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "lineage-quota.txt");
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, "q".repeat(64 * 1024), "utf8");
  let activeOccurrenceId = "";
  let activeReadCount = 0;
  let expectQuotaFailure = false;
  let activeBatchIssued = false;
  let ordinaryProviderCalls = 0;
  let compactionProviderCalls = 0;
  let toolCallOrdinal = 0;
  const driver = new FakeModelDriver((request) => {
    if (request.tools.length === 0) {
      compactionProviderCalls += 1;
      return [
        {
          type: "text_delta",
          text: JSON.stringify({
            schemaVersion: 1,
            objective: "Preserve the linked input-resource lineage quota.",
            constraints: [],
            progress: [],
            unresolvedQuestions: [],
            failures: [],
            remainingVerification: ["Continue exact quota accounting."],
            nextSafeAction: "Continue the next bounded run.",
          }),
        },
        { type: "usage", inputTokens: 700_000, outputTokens: 32 },
        { type: "finish", reason: "stop" },
      ];
    }
    ordinaryProviderCalls += 1;
    if (!activeBatchIssued) {
      activeBatchIssued = true;
      return [
        ...Array.from({ length: activeReadCount }, () => {
          toolCallOrdinal += 1;
          const callId = `lineage-quota-${toolCallOrdinal}`;
          return [
            { type: "tool_call_start" as const, id: callId, name: "read_input_resource" },
            {
              type: "tool_call_delta" as const,
              id: callId,
              json: JSON.stringify({
                occurrenceId: activeOccurrenceId,
                maxByteCount: 64 * 1024,
              }),
            },
            { type: "tool_call_end" as const, id: callId },
          ];
        }).flat(),
        { type: "finish" as const, reason: "tool_calls" as const },
      ];
    }
    return [
      {
        type: "text_delta",
        text: expectQuotaFailure
          ? "The lineage quota rejected another page."
          : "The run materialized one MiB.",
      },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const created = await lifecycle.create({ targetIdentity });
    for (let index = 1; index <= 8; index += 1) {
      const runId = `20000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
      activeOccurrenceId = `${runId}:input:1`;
      activeReadCount = 16;
      expectQuotaFailure = false;
      activeBatchIssued = false;
      await expect(
        lifecycle.continue({
          sessionId: created.sessionId,
          input: { text: `Materialize lineage MiB ${index}.` },
          resourceSelections: [{ type: "local_file", path: selectedPath }],
          runId,
        }),
      ).resolves.toMatchObject({ result: { status: "completed" } });
    }
    const overflowRunId = "20000000-0000-4000-8000-000000000009";
    activeOccurrenceId = `${overflowRunId}:input:1`;
    activeReadCount = 1;
    expectQuotaFailure = true;
    activeBatchIssued = false;
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Reject another lineage materialization page." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
        runId: overflowRunId,
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "The lineage quota rejected another page." },
    });
    const store = await openJsonlSessionStore({
      stateRoot,
      workspaceRoot,
      sessionId: created.sessionId,
    });
    const records = await store.read();
    expect(
      records.filter(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "input_resource_read_committed",
      ),
    ).toHaveLength(128);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record: expect.objectContaining({
            type: "runtime_event",
            event: expect.objectContaining({
              type: "tool_failed",
              error: expect.objectContaining({ code: "input_resource_quota_exceeded" }),
            }),
          }),
        }),
      ]),
    );
    expect(ordinaryProviderCalls).toBe(18);
    expect(compactionProviderCalls).toBeGreaterThan(0);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle preserves duplicate selections as ordered occurrences over one artifact", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-input-resource-duplicate-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "shared.txt");
  const content = "same immutable bytes\n";
  const digest = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
  const runId = "20000000-0000-4000-8000-000000000011";
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, content, "utf8");
  let projectedOccurrences: readonly {
    readonly occurrenceId: string;
    readonly artifact: { readonly id: string };
  }[] = [];
  const driver = new FakeModelDriver((request) => {
    const user = request.messages.at(-1);
    if (user?.role !== "user") {
      throw new Error("Expected the duplicate resource descriptor request.");
    }
    if (typeof user.content !== "string") {
      throw new Error("Expected descriptor-only text for duplicate resources.");
    }
    projectedOccurrences = JSON.parse(user.content.split("\n").at(-1) ?? "[]") as readonly {
      readonly occurrenceId: string;
      readonly artifact: { readonly id: string };
    }[];
    return [
      { type: "text_delta", text: "Both occurrences are visible." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const admitted = await lifecycle.admit({
      targetIdentity,
      input: { text: "Keep both links." },
      resourceSelections: [
        { type: "local_file", path: selectedPath },
        { type: "local_file", path: selectedPath },
      ],
      runId,
    });
    expect(projectedOccurrences).toHaveLength(2);
    expect(projectedOccurrences.map((entry) => entry.occurrenceId)).toEqual([
      `${runId}:input:1`,
      `${runId}:input:2`,
    ]);
    expect(projectedOccurrences.map((entry) => entry.artifact.id)).toEqual([digest, digest]);
    const store = await harness.sessions.open(admitted.snapshot.sessionId);
    const logicalRun = (await store?.read())?.find(
      (record) => record.schemaVersion === 3 && record.record.type === "logical_run_started",
    );
    const durableOccurrences =
      logicalRun?.schemaVersion === 3 && logicalRun.record.type === "logical_run_started"
        ? logicalRun.record.inputResources
        : undefined;
    expect(durableOccurrences).toHaveLength(2);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a ninth input-resource occurrence before provider dispatch", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-input-resource-count-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "bounded.txt");
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, "bounded\n", "utf8");
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return [{ type: "finish", reason: "stop" }];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Reject the ninth link." },
        resourceSelections: Array.from({ length: 9 }, () => ({
          type: "local_file" as const,
          path: selectedPath,
        })),
      }),
    ).rejects.toMatchObject({ code: "input_resource_count_exceeded" });
    expect(providerCalls).toBe(0);
    const sessionIds = await harness.sessions.listSessionIds();
    expect(sessionIds).toHaveLength(1);
    const store = await harness.sessions.open(sessionIds[0] as string);
    expect(await store?.read()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record: expect.objectContaining({ type: "logical_run_started" }),
        }),
      ]),
    );
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a sixty-fifth lineage input-resource occurrence before logical commit", async () => {
  const testRoot = await mkdtemp(
    join(tmpdir(), "adam-agent-session-input-resource-lineage-count-"),
  );
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const selectedPath = join(testRoot, "lineage-resource.txt");
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, "lineage\n", "utf8");
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return [
      { type: "text_delta", text: "Accepted bounded lineage resources." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const selections = Array.from(
      { length: 8 },
      (): LocalInputResourceSelectionV1 => ({ type: "local_file", path: selectedPath }),
    );
    let lastSequence = created.lastSequence;
    for (let index = 0; index < 8; index += 1) {
      const continued = await lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: `Commit lineage resource batch ${index + 1}.` },
        resourceSelections: selections,
      });
      lastSequence = continued.snapshot.lastSequence;
    }

    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Reject lineage occurrence 65." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
      }),
    ).rejects.toMatchObject({ code: "input_resource_count_exceeded" });
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      lastSequence,
    });
    expect(providerCalls).toBe(8);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle leaves only a safe orphan when input-resource logical commit fails", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-input-resource-orphan-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "orphan.txt");
  const content = "Published before the failed reference.\n";
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, content, "utf8");
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return [{ type: "finish", reason: "stop" }];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const backing = createInMemorySessionStoreDirectory<SessionRecord>();
  const wrapStore = (
    store: Awaited<ReturnType<SessionStoreDirectory<SessionRecord>["create"]>>,
  ) => ({
    async append(record: SessionRecord) {
      if (record.schemaVersion === 3 && record.record.type === "logical_run_started") {
        throw new Error("logical commit failed");
      }
      await store.append(record);
    },
    read: () => store.read(),
  });
  const failingDirectory: SessionStoreDirectory<SessionRecord> = {
    async create(sessionId) {
      return wrapStore(await backing.create(sessionId));
    },
    listSessionEntries: () => backing.listSessionEntries(),
    listSessionIds: () => backing.listSessionIds(),
    async open(sessionId) {
      const store = await backing.open(sessionId);
      return store === undefined ? undefined : wrapStore(store);
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    [sessionAutomaticTitlesEnabled]: false,
    [sessionStoreDirectory]: failingDirectory,
  });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Fail this logical reference." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
      }),
    ).resolves.toMatchObject({
      result: {
        status: "failed",
        error: { code: "session_persistence_failed" },
      },
    });
    expect(providerCalls).toBe(0);
    await expect(readFile(join(stateRoot, "artifacts", digest))).resolves.toEqual(
      Buffer.from(content, "utf8"),
    );
    const sessionIds = await backing.listSessionIds();
    const store = await backing.open(sessionIds[0] as string);
    expect(await store?.read()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record: expect.objectContaining({ type: "logical_run_started" }),
        }),
      ]),
    );
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle cancellation settles input-resource ingest without a durable reference", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-input-resource-cancel-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "cancel.txt");
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, "cancel before resource bytes are published\n", "utf8");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const controller = new AbortController();
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return [{ type: "finish", reason: "stop" }];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    [inputResourceIngestBarrier]: {
      async afterOpened() {
        entered.resolve();
        await release.promise;
      },
    },
  });

  try {
    const admission = lifecycle.admit({
      targetIdentity,
      input: { text: "Cancel this resource ingest." },
      resourceSelections: [{ type: "local_file", path: selectedPath }],
      signal: controller.signal,
    });
    await entered.promise;
    controller.abort();
    release.resolve();
    await expect(admission).rejects.toMatchObject({ name: "AbortError" });
    expect(providerCalls).toBe(0);
    await expect(readdir(join(stateRoot, "artifacts"))).resolves.toEqual([]);
    const sessionIds = await harness.sessions.listSessionIds();
    const store = await harness.sessions.open(sessionIds[0] as string);
    expect(await store?.read()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record: expect.objectContaining({ type: "logical_run_started" }),
        }),
      ]),
    );
  } finally {
    release.resolve();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a source truncated after its accepted descriptor is opened", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-input-resource-short-read-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "changing.txt");
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, "accepted size then truncated\n", "utf8");
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return [{ type: "finish", reason: "stop" }];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    [inputResourceIngestBarrier]: {
      async afterOpened() {
        await truncate(selectedPath, 0);
      },
    },
  });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Do not admit a changing resource." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
      }),
    ).rejects.toMatchObject({ code: "input_resource_io_failed" });
    expect(providerCalls).toBe(0);
    await expect(readdir(join(stateRoot, "artifacts"))).resolves.toEqual([]);
    const sessionIds = await harness.sessions.listSessionIds();
    const store = await harness.sessions.open(sessionIds[0] as string);
    expect(await store?.read()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record: expect.objectContaining({ type: "logical_run_started" }),
        }),
      ]),
    );
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle prefix branch exposes only input-resource occurrences inside its boundary", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-input-resource-branch-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const firstPath = join(testRoot, "first.txt");
  const laterPath = join(testRoot, "later.txt");
  const firstRunId = "40000000-0000-4000-8000-000000000011";
  const laterRunId = "40000000-0000-4000-8000-000000000012";
  const firstOccurrenceId = `${firstRunId}:input:1`;
  const laterOccurrenceId = `${laterRunId}:input:1`;
  await mkdir(workspaceRoot);
  await writeFile(firstPath, "first prefix bytes\n", "utf8");
  await writeFile(laterPath, "later parent bytes\n", "utf8");
  let providerCalls = 0;
  const driver = new FakeModelDriver((request) => {
    providerCalls += 1;
    if (providerCalls <= 2) {
      return [
        { type: "text_delta", text: `Parent turn ${providerCalls}.` },
        { type: "finish", reason: "stop" },
      ];
    }
    if (providerCalls === 3) {
      const userDescriptors = request.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content)
        .join("\n");
      expect(userDescriptors).toContain(firstOccurrenceId);
      expect(userDescriptors).not.toContain(laterOccurrenceId);
      return [
        { type: "tool_call_start", id: "prefix-visible", name: "read_input_resource" },
        {
          type: "tool_call_delta",
          id: "prefix-visible",
          json: JSON.stringify({ occurrenceId: firstOccurrenceId }),
        },
        { type: "tool_call_end", id: "prefix-visible" },
        { type: "tool_call_start", id: "prefix-hidden", name: "read_input_resource" },
        {
          type: "tool_call_delta",
          id: "prefix-hidden",
          json: JSON.stringify({ occurrenceId: laterOccurrenceId }),
        },
        { type: "tool_call_end", id: "prefix-hidden" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    const results = request.messages.filter((message) => message.role === "tool");
    expect(results).toEqual([
      expect.objectContaining({
        callId: "prefix-visible",
        result: expect.objectContaining({
          status: "completed",
          output: expect.objectContaining({ content: "first prefix bytes\n" }),
        }),
      }),
      expect.objectContaining({
        callId: "prefix-hidden",
        result: {
          status: "failed",
          error: {
            code: "input_resource_not_visible",
            message:
              "The requested input-resource occurrence is not visible in this session history.",
          },
        },
      }),
    ]);
    return [
      { type: "text_delta", text: "Only the prefix resource is available." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const first = await lifecycle.admit({
      targetIdentity,
      input: { text: "Link the prefix resource." },
      resourceSelections: [{ type: "local_file", path: firstPath }],
      runId: firstRunId,
    });
    await lifecycle.continue({
      sessionId: first.snapshot.sessionId,
      input: { text: "Link the later resource." },
      resourceSelections: [{ type: "local_file", path: laterPath }],
      runId: laterRunId,
    });
    const branch = await lifecycle.branch({
      parentSessionId: first.snapshot.sessionId,
      atSequence: first.snapshot.lastSequence,
    });
    await expect(
      lifecycle.continue({
        sessionId: branch.sessionId,
        input: { text: "Read only the prefix resource." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "Only the prefix resource is available." },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle projects one validated PNG only for the exact Vision Chat profile", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-vision-chat-png-"));
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "one-pixel.png");
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const digest = `sha256:${createHash("sha256").update(pngBytes).digest("hex")}` as const;
  const visionIdentity: ModelTargetIdentity = {
    targetId: "deepseek-v4-flash-vision-exp.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-flash-vision-exp",
    route: "direct",
    profileVersion: 1,
    certification: "certified",
  };
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, pngBytes);

  const visionDriver = new FakeModelDriver((request) => {
    expect(request.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Describe the exact image." },
        {
          type: "file",
          artifactId: digest,
          mediaType: "image/png",
          bytes: new Uint8Array(pngBytes),
        },
      ],
    });
    return [
      { type: "text_delta", text: "The image contains one exact pixel." },
      { type: "finish", reason: "stop" },
    ];
  });
  const visionTargets: ModelTargets = {
    async resolve() {
      return {
        identity: visionIdentity,
        driver: visionDriver,
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
        modalityProfile: {
          profileVersion: 1 as const,
          explicitUserImages: "supported" as const,
          imageToolResults: "unsupported" as const,
        },
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: visionIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
          },
        ],
      };
    },
  };
  const visionHarness = createInMemorySessionLifecycleHarness();
  const visionLifecycle = visionHarness.createLifecycle({
    modelTargets: visionTargets,
    stateRoot: join(testRoot, "vision-state"),
    workspaceRoot,
  });
  let flashDriverCalls = 0;
  const flashDriver = new FakeModelDriver(() => {
    flashDriverCalls += 1;
    return [
      { type: "text_delta", text: "This target must not receive an image." },
      { type: "finish", reason: "stop" },
    ];
  });
  const flashTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: flashDriver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const flashLifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets: flashTargets,
    stateRoot: join(testRoot, "flash-state"),
    workspaceRoot,
  });

  try {
    const admitted = await visionLifecycle.admit({
      targetIdentity: visionIdentity,
      input: { text: "Describe the exact image." },
      resourceSelections: [{ type: "local_file", path: selectedPath }],
    });
    expect(admitted).toMatchObject({
      result: { status: "completed", answer: "The image contains one exact pixel." },
    });
    const visionStore = await visionHarness.sessions.open(admitted.snapshot.sessionId);
    if (visionStore === undefined) {
      throw new Error("Expected the Vision Chat session store.");
    }
    expect(
      (await visionStore.read()).find(
        (record) => record.schemaVersion === 3 && record.record.type === "provider_attempt_started",
      ),
    ).toMatchObject({
      record: {
        projectedContent: {
          version: 1,
          explicitUserImages: {
            count: 1,
            byteCount: pngBytes.byteLength,
            pixelCount: 1,
            maximumWidth: 1,
            maximumHeight: 1,
          },
        },
      },
    });
    await expect(
      flashLifecycle.admit({
        targetIdentity,
        input: { text: "Describe the exact image." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
      }),
    ).resolves.toMatchObject({
      result: {
        status: "failed",
        error: {
          code: "input_resource_unsupported",
          message: "The selected target does not support explicit user images.",
        },
      },
    });
    expect(flashDriverCalls).toBe(0);
  } finally {
    await Promise.all([visionLifecycle.close(), flashLifecycle.close()]);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle projects one validated JPEG through the exact Vision Chat profile", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-vision-chat-jpeg-"));
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "one-pixel.jpg");
  const jpegBytes = Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRQBAwQEBQQFCQUFCRQNCw0UFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFP/AABEIAAEAAQMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/APnSvww/1TP/2Q==",
    "base64",
  );
  const digest = `sha256:${createHash("sha256").update(jpegBytes).digest("hex")}` as const;
  const visionIdentity: ModelTargetIdentity = {
    targetId: "deepseek-v4-flash-vision-exp.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-flash-vision-exp",
    route: "direct",
    profileVersion: 1,
    certification: "certified",
  };
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, jpegBytes);
  const driver = new FakeModelDriver((request) => {
    expect(request.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Describe the JPEG." },
        {
          type: "file",
          artifactId: digest,
          mediaType: "image/jpeg",
          bytes: new Uint8Array(jpegBytes),
        },
      ],
    });
    return [
      { type: "text_delta", text: "The JPEG contains one exact pixel." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: visionIdentity,
        driver,
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
        modalityProfile: {
          profileVersion: 1,
          explicitUserImages: "supported",
          imageToolResults: "unsupported",
        },
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: visionIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    stateRoot: join(testRoot, "state"),
    workspaceRoot,
  });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity: visionIdentity,
        input: { text: "Describe the JPEG." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "The JPEG contains one exact pixel." },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle trusts validated image bytes over names and rejects images that fail complete decoding", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-vision-chat-magic-"));
  const workspaceRoot = join(testRoot, "workspace");
  const misleadingPath = join(testRoot, "actually-png.jpg");
  const truncatedPath = join(testRoot, "truncated.png");
  const corruptImageDataPath = join(testRoot, "corrupt-image-data.png");
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const digest = `sha256:${createHash("sha256").update(pngBytes).digest("hex")}` as const;
  const visionIdentity: ModelTargetIdentity = {
    targetId: "deepseek-v4-flash-vision-exp.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-flash-vision-exp",
    route: "direct",
    profileVersion: 1,
    certification: "certified",
  };
  await mkdir(workspaceRoot);
  await writeFile(misleadingPath, pngBytes);
  await writeFile(truncatedPath, pngBytes.subarray(0, 12));
  await writeFile(
    corruptImageDataPath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVSH2mNk+A8AAQUBAT0jcMwAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  let driverCalls = 0;
  const driver = new FakeModelDriver((request) => {
    driverCalls += 1;
    expect(request.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Use byte truth." },
        {
          type: "file",
          artifactId: digest,
          mediaType: "image/png",
          bytes: new Uint8Array(pngBytes),
        },
      ],
    });
    return [
      { type: "text_delta", text: "Byte truth wins." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: visionIdentity,
        driver,
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
        modalityProfile: {
          profileVersion: 1,
          explicitUserImages: "supported",
          imageToolResults: "unsupported",
        },
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: visionIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    stateRoot: join(testRoot, "state"),
    workspaceRoot,
  });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity: visionIdentity,
        input: { text: "Use byte truth." },
        resourceSelections: [{ type: "local_file", path: misleadingPath }],
      }),
    ).resolves.toMatchObject({ result: { status: "completed", answer: "Byte truth wins." } });
    await expect(
      lifecycle.admit({
        targetIdentity: visionIdentity,
        input: { text: "Reject truncated magic." },
        resourceSelections: [{ type: "local_file", path: truncatedPath }],
      }),
    ).resolves.toMatchObject({
      result: {
        status: "failed",
        error: {
          code: "input_resource_invalid",
          message: "The selected image is corrupt or has an unsupported image format.",
        },
      },
    });
    await expect(
      lifecycle.admit({
        targetIdentity: visionIdentity,
        input: { text: "Reject corrupt decoded pixels." },
        resourceSelections: [{ type: "local_file", path: corruptImageDataPath }],
      }),
    ).resolves.toMatchObject({
      result: {
        status: "failed",
        error: {
          code: "input_resource_invalid",
          message: "The selected image is corrupt or has an unsupported image format.",
        },
      },
    });
    expect(driverCalls).toBe(1);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle enforces the exact v1 image count and dimension budgets before the driver", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-vision-chat-bounds-"));
  const workspaceRoot = join(testRoot, "workspace");
  const oversizedDimensionPath = join(testRoot, "too-wide.png");
  const firstPath = join(testRoot, "first.png");
  const secondPath = join(testRoot, "second.png");
  const onePixelPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const tooWidePng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAEAEAAAABCAQAAAAb6sjJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const visionIdentity: ModelTargetIdentity = {
    targetId: "deepseek-v4-flash-vision-exp.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-flash-vision-exp",
    route: "direct",
    profileVersion: 1,
    certification: "certified",
  };
  await mkdir(workspaceRoot);
  await writeFile(oversizedDimensionPath, tooWidePng);
  await writeFile(firstPath, onePixelPng);
  await writeFile(secondPath, onePixelPng);
  let driverCalls = 0;
  const driver = new FakeModelDriver(() => {
    driverCalls += 1;
    return [{ type: "finish", reason: "stop" }];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: visionIdentity,
        driver,
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
        modalityProfile: {
          profileVersion: 1,
          explicitUserImages: "supported",
          imageToolResults: "unsupported",
        },
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: visionIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    stateRoot: join(testRoot, "state"),
    workspaceRoot,
  });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity: visionIdentity,
        input: { text: "Reject oversized dimensions." },
        resourceSelections: [{ type: "local_file", path: oversizedDimensionPath }],
      }),
    ).resolves.toMatchObject({
      result: {
        status: "failed",
        error: {
          code: "input_resource_limit_exceeded",
          message: "The selected image dimensions exceed the v1 limit.",
        },
      },
    });
    await expect(
      lifecycle.admit({
        targetIdentity: visionIdentity,
        input: { text: "Reject a second explicit image." },
        resourceSelections: [
          { type: "local_file", path: firstPath },
          { type: "local_file", path: secondPath },
        ],
      }),
    ).resolves.toMatchObject({
      result: {
        status: "failed",
        error: {
          code: "input_resource_limit_exceeded",
          message: "At most one explicit user image is supported per run.",
        },
      },
    });
    expect(driverCalls).toBe(0);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle preserves a Vision Chat image through reasoning and a tool continuation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-vision-chat-tool-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "tool-image.png");
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const artifactId = `sha256:${createHash("sha256").update(pngBytes).digest("hex")}` as const;
  const visionIdentity: ModelTargetIdentity = {
    targetId: "deepseek-v4-flash-vision-exp.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-flash-vision-exp",
    route: "direct",
    profileVersion: 1,
    certification: "certified",
  };
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "# Adam\n", "utf8");
  await writeFile(selectedPath, pngBytes);
  const productionSnapshot = await createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
  }).snapshot({ signal: new AbortController().signal });
  const thinkingCapability = productionSnapshot.targets.find((target) =>
    Object.is(target.identity.targetId, visionIdentity.targetId),
  )?.thinkingCapability;
  if (thinkingCapability === undefined) {
    throw new Error("Expected the exact Vision Chat thinking capability.");
  }
  let requestCount = 0;
  const driver = new FakeModelDriver((request) => {
    requestCount += 1;
    expect(request.messages.find((message) => message.role === "user")).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Use the image and inspect the project." },
        {
          type: "file",
          artifactId,
          mediaType: "image/png",
          bytes: new Uint8Array(pngBytes),
        },
      ],
    });
    expect(request.thinkingPolicy).toMatchObject({
      requestedLevelId: "high",
      mapping: {
        requestPath: "provider_options.deepseek",
        thinkingType: "enabled",
        reasoningEffort: "high",
      },
    });
    if (requestCount === 1) {
      return [
        {
          type: "reasoning_start",
          id: "provider-reasoning-0",
          artifactType: "provider_reasoning",
        },
        {
          type: "reasoning_delta",
          id: "provider-reasoning-0",
          text: "I should inspect the project before answering.",
        },
        { type: "reasoning_end", id: "provider-reasoning-0" },
        { type: "tool_call_start", id: "vision-read", name: "read_file" },
        { type: "tool_call_delta", id: "vision-read", json: '{"path":"README.md"}' },
        { type: "tool_call_end", id: "vision-read" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    expect(request.messages.at(-1)).toMatchObject({
      role: "tool",
      callId: "vision-read",
      name: "read_file",
      result: { status: "completed" },
    });
    return [
      { type: "text_delta", text: "The image and Adam project are both available." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: visionIdentity,
        driver,
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
        modalityProfile: {
          profileVersion: 1,
          explicitUserImages: "supported",
          imageToolResults: "unsupported",
        },
        thinkingCapability,
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: visionIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
            thinkingCapability,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    tools: createReadToolRegistry({ workspaceRoot }),
    workspaceRoot,
  });

  try {
    const admitted = await lifecycle.admit({
      targetIdentity: visionIdentity,
      input: { text: "Use the image and inspect the project." },
      resourceSelections: [{ type: "local_file", path: selectedPath }],
      thinkingSelection: thinkingSelection(thinkingCapability, "high"),
    });
    expect(admitted.result).toEqual({
      status: "completed",
      answer: "The image and Adam project are both available.",
    });
    const store = await harness.sessions.open(admitted.snapshot.sessionId);
    const responses = (await store?.read())?.filter(
      (record) => record.schemaVersion === 3 && record.record.type === "model_response_completed",
    );
    expect(responses?.[0]).toMatchObject({
      record: {
        response: {
          reasoning: "I should inspect the project before answering.",
          toolCalls: [{ id: "vision-read", name: "read_file" }],
        },
      },
    });
    expect(requestCount).toBe(2);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle links binary bytes but returns typed unsupported materialization", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-input-resource-binary-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "binary.dat");
  const runId = "50000000-0000-4000-8000-000000000011";
  const occurrenceId = `${runId}:input:1`;
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, Buffer.from([0xff, 0xfe, 0x00, 0x41]));
  let providerCalls = 0;
  const driver = new FakeModelDriver((request) => {
    providerCalls += 1;
    if (providerCalls === 1) {
      const user = request.messages.at(-1);
      expect(user?.role === "user" ? user.content : "").toContain('"support":"unsupported_binary"');
      return [
        { type: "tool_call_start", id: "binary-resource", name: "read_input_resource" },
        {
          type: "tool_call_delta",
          id: "binary-resource",
          json: JSON.stringify({ occurrenceId }),
        },
        { type: "tool_call_end", id: "binary-resource" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    expect(request.messages.at(-1)).toEqual({
      role: "tool",
      callId: "binary-resource",
      name: "read_input_resource",
      result: {
        status: "failed",
        error: {
          code: "input_resource_unsupported",
          message: "The requested input resource is not supported as strict UTF-8 text.",
        },
      },
    });
    return [
      { type: "text_delta", text: "The linked resource is unsupported binary." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
  });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Inspect the binary link." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
        runId,
      }),
    ).resolves.toMatchObject({
      result: {
        status: "completed",
        answer: "The linked resource is unsupported binary.",
      },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects invalid draft run limits before allocating durable session identity", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-draft-limits-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const harness = createInMemorySessionLifecycleHarness();
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: targetIdentity,
        driver: new FakeModelDriver([]),
        contextProfile: testContextProfile,
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = harness.createLifecycle({ modelTargets, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Reject invalid limits before genesis" },
        limits: { maxTurns: 0 },
      }),
    ).rejects.toMatchObject({ code: "session_invalid" });
    await expect(harness.sessions.listSessionIds()).resolves.toEqual([]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle paginates prompt-admitted sessions while hiding genesis-only history", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-memory-catalog-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const harness = createInMemorySessionLifecycleHarness();
  const driver = new FakeModelDriver(() => [
    { type: "text_delta", text: "Cataloged answer." },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = harness.createLifecycle({ modelTargets, workspaceRoot });

  try {
    const genesisOnly = await lifecycle.create({ targetIdentity });
    const admitted = [
      await lifecycle.create({ targetIdentity }),
      await lifecycle.create({ targetIdentity }),
    ];
    for (const [index, session] of admitted.entries()) {
      await lifecycle.continue({
        sessionId: session.sessionId,
        input: { text: `Catalog prompt ${index + 1}` },
      });
    }
    const firstPage = await lifecycle.listProjectSessions({ limit: 1 });
    if (firstPage.nextCursor === null) {
      throw new Error("The first in-memory catalog page requires a continuation cursor.");
    }
    const secondPage = await lifecycle.listProjectSessions({
      cursor: firstPage.nextCursor,
      limit: 1,
    });

    expect([...firstPage.items, ...secondPage.items].map((item) => item.sessionId)).toEqual(
      admitted.map((item) => item.sessionId).reverse(),
    );
    expect([...firstPage.items, ...secondPage.items]).not.toContainEqual(
      expect.objectContaining({ sessionId: genesisOnly.sessionId }),
    );
    expect({ first: firstPage.nextCursor, second: secondPage.nextCursor }).toEqual({
      first: expect.any(String),
      second: null,
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle creates a prompt-v3 genesis with an empty bounded Skill snapshot and seven tools", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-skills-genesis-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const harness = createInMemorySessionLifecycleHarness();

  try {
    const tools = createCodingToolRegistry({ stateRoot, workspaceRoot });
    const lifecycle = harness.createLifecycle({ stateRoot, tools, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const inspected = await lifecycle.inspect({ sessionId: created.sessionId });

    const expectedSkills = {
      profileVersion: 1,
      catalog: {
        revision: 1,
        totalCount: 0,
        includedCount: 0,
        omittedCount: 0,
        shortenedCount: 0,
        budgetTokens: 10_000,
        projectedTokens: 0,
      },
      active: [],
    };
    for (const snapshot of [created, inspected]) {
      expect(snapshot).toMatchObject({
        promptContext: {
          profileVersion: 3,
          assemblyVersion: 3,
          toolProfile: {
            definitions: [
              { name: "read_file" },
              { name: "write_file" },
              { name: "edit_file" },
              { name: "run_shell" },
              { name: "activate_skill" },
              { name: "read_skill_resource" },
              { name: "read_input_resource" },
            ],
          },
        },
        skillContext: expectedSkills,
      });
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle restores an uncompacted v1 session after the current target advances", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-historical-v1-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const harness = createInMemorySessionLifecycleHarness();
  const created = await harness.createLifecycle({ stateRoot, workspaceRoot }).create({
    targetIdentity,
  });
  const v2Identity: ModelTargetIdentity = { ...targetIdentity, profileVersion: 2 };
  const observedBudgets: Array<number | undefined> = [];
  let v2DriverCalls = 0;
  const v1Driver = new FakeModelDriver((request) => {
    observedBudgets.push(request.maximumOutputTokens);
    return [
      { type: "text_delta", text: "Historical v1 restored." },
      { type: "finish", reason: "stop" },
    ];
  });
  const upgradedTargets: ModelTargets = {
    async resolve(input) {
      const exactIdentity = (
        input as typeof input & { readonly targetIdentity?: ModelTargetIdentity }
      ).targetIdentity;
      if (exactIdentity?.profileVersion === 1) {
        return { identity: targetIdentity, driver: v1Driver, contextProfile: testContextProfile };
      }
      v2DriverCalls += 1;
      return {
        identity: v2Identity,
        driver: new FakeModelDriver([]),
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
      };
    },
    async snapshot(input) {
      const includeHistoricalProfiles = (
        input as typeof input & { readonly includeHistoricalProfiles?: boolean }
      ).includeHistoricalProfiles;
      const current = {
        identity: v2Identity,
        readiness: { status: "available" as const, credentialSource: "test" },
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
      };
      const historical = {
        identity: targetIdentity,
        readiness: { status: "available" as const, credentialSource: "test" },
        contextProfile: testContextProfile,
      };
      return { targets: includeHistoricalProfiles ? [current, historical] : [current] };
    },
  };

  try {
    const continued = await harness
      .createLifecycle({
        modelTargets: upgradedTargets,
        stateRoot,
        workspaceRoot,
      })
      .continue({
        sessionId: created.sessionId,
        input: { text: "Continue with the historical profile." },
      });

    expect({ result: continued.result, observedBudgets, v2DriverCalls }).toEqual({
      result: { status: "completed", answer: "Historical v1 restored." },
      observedBudgets: [32_768],
      v2DriverCalls: 0,
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects an unsupported historical profile before model resolution", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-unsupported-profile-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const unsupportedIdentity: ModelTargetIdentity = {
    ...targetIdentity,
    profileVersion: 99,
  };
  const unsupportedProfile: ContextProfile = {
    ...testContextProfile,
    version: 99,
  };
  let resolveCalls = 0;
  const modelTargets: ModelTargets = {
    async resolve() {
      resolveCalls += 1;
      return {
        identity: unsupportedIdentity,
        driver: new FakeModelDriver([]),
        contextProfile: unsupportedProfile,
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: unsupportedIdentity,
            readiness: { status: "available", credentialSource: "test" },
            contextProfile: unsupportedProfile,
          },
        ],
      };
    },
  };

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const created = await harness.createLifecycle({ stateRoot, workspaceRoot }).create({
      targetIdentity: unsupportedIdentity,
    });
    await expect(
      harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot }).resume({
        sessionId: created.sessionId,
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "model_target_incompatible" },
    });
    await expect(
      harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot }).continue({
        sessionId: created.sessionId,
        input: { text: "This request must not reach the model." },
      }),
    ).rejects.toMatchObject({ code: "session_model_target_incompatible" });
    expect(resolveCalls).toBe(0);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects restored v3 records that violate session causality", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-invalid-causality-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    await store.append({
      schemaVersion: 3,
      sequence: 2,
      record: {
        type: "provider_attempt_started",
        runId: "123e4567-e89b-42d3-a456-426614174099",
        turn: 1,
        attempt: 1,
        targetIdentity,
      },
    });

    await expect(lifecycle.inspect({ sessionId: created.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each(["failed", "interrupted"] as const)(
  "SessionLifecycle rejects a %s reasoning block followed by an answer-only completed response",
  async (status) => {
    const testRoot = await mkdtemp(
      join(tmpdir(), `adam-agent-session-invalid-reasoning-${status}-`),
    );
    const stateRoot = join(testRoot, "state");
    const workspaceRoot = join(testRoot, "workspace");
    await mkdir(workspaceRoot);

    try {
      const harness = createInMemorySessionLifecycleHarness();
      const lifecycle = harness.createLifecycle({ stateRoot, workspaceRoot });
      const created = await lifecycle.create({ targetIdentity });
      const runId = "123e4567-e89b-42d3-a456-426614174097";
      const store = await harness.sessions.open(created.sessionId);
      if (store === undefined) {
        throw new Error("Expected the created session store.");
      }
      const records: readonly Omit<
        Extract<SessionRecord, { readonly schemaVersion: 3 }>,
        "sequence"
      >[] = [
        {
          schemaVersion: 3,
          record: { type: "logical_run_started", runId, userMessage: "Reject split outcome" },
        },
        {
          schemaVersion: 3,
          record: {
            type: "runtime_event",
            runId,
            event: { type: "user_message", text: "Reject split outcome" },
          },
        },
        {
          schemaVersion: 3,
          record: {
            type: "provider_attempt_started",
            runId,
            turn: 1,
            attempt: 1,
            targetIdentity,
            promptProjection: promptProjectionFor(created, "Reject split outcome"),
          },
        },
        {
          schemaVersion: 3,
          record: { type: "runtime_event", runId, event: { type: "model_message_started" } },
        },
        {
          schemaVersion: 3,
          record: {
            type: "runtime_event",
            runId,
            event: {
              type: "model_reasoning_started",
              id: "1:1:provider-reasoning-0",
              artifactType: "provider_reasoning",
            },
          },
        },
        {
          schemaVersion: 3,
          record: {
            type: "runtime_event",
            runId,
            event: { type: "model_reasoning_settled", id: "1:1:provider-reasoning-0", status },
          },
        },
        {
          schemaVersion: 3,
          record: {
            type: "model_response_completed",
            runId,
            turn: 1,
            attempt: 1,
            targetIdentity,
            response: {
              text: "Impossible answer.",
              toolCalls: [],
              toolIntents: [],
              finishReason: "stop",
            },
          },
        },
      ];
      for (const [index, record] of records.entries()) {
        await store.append({ ...record, sequence: index + 2 } as SessionRecord);
      }

      await expect(lifecycle.inspect({ sessionId: created.sessionId })).rejects.toMatchObject({
        code: "session_invalid",
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test("SessionLifecycle rejects a fabricated completed settlement without a provider response", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-invalid-settlement-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174098";
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    await store.append({
      schemaVersion: 3,
      sequence: 2,
      record: { type: "logical_run_started", runId, userMessage: "Fabricate success" },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 3,
      record: {
        type: "runtime_event",
        runId,
        event: { type: "user_message", text: "Fabricate success" },
      },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 4,
      record: {
        type: "runtime_event",
        runId,
        event: {
          type: "session_settled",
          result: { status: "completed", answer: "Invented answer" },
        },
      },
    });

    await expect(lifecycle.inspect({ sessionId: created.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle keeps legacy history inspectable but rejects model resume without guessing", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-legacy-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const sessionId = "legacy-session";
  await mkdir(workspaceRoot);
  const harness = createInMemorySessionLifecycleHarness();
  const store = await harness.sessions.create(sessionId);
  await store.append({
    schemaVersion: 1,
    runId: "123e4567-e89b-42d3-a456-426614174000",
    sequence: 1,
    event: { type: "user_message", text: "Legacy request" },
  });
  await store.append({
    schemaVersion: 2,
    runId: "123e4567-e89b-42d3-a456-426614174000",
    sequence: 2,
    event: {
      type: "session_settled",
      result: { status: "completed", answer: "Legacy answer" },
    },
  });

  try {
    const lifecycle = harness.createLifecycle({ stateRoot, workspaceRoot });
    const inspected = await lifecycle.inspect({ sessionId });
    const resumed = await lifecycle.resume({ sessionId });

    const legacySnapshot = {
      schemaVersion: 2,
      sessionId,
      projectId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      status: "legacy",
      lastSequence: 2,
    };
    expect({ inspected, resumed }).toEqual({
      inspected: legacySnapshot,
      resumed: {
        status: "rejected",
        snapshot: legacySnapshot,
        error: {
          code: "non_resumable_legacy_session",
          message: "Legacy session history can be inspected but cannot be resumed safely.",
        },
      },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle hydrate-only resume validates the exact target without model or durable effects", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-resume-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let providerWasCalled = false;
  const harness = createInMemorySessionLifecycleHarness();

  try {
    const created = await harness.createLifecycle({ stateRoot, workspaceRoot }).create({
      targetIdentity,
    });
    const modelTargets = createModelTargets({
      environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
      fetch: async () => {
        providerWasCalled = true;
        throw new Error("hydrate-only resume must not call the provider");
      },
    });
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const before = await lifecycle.inspect({ sessionId: created.sessionId });

    const resumed = await lifecycle.resume({ sessionId: created.sessionId });
    const after = await lifecycle.inspect({ sessionId: created.sessionId });

    expect({ resumed, providerWasCalled, historyUnchanged: after }).toEqual({
      resumed: { status: "ready", snapshot: before },
      providerWasCalled: false,
      historyUnchanged: before,
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle branches a complete boundary by reference without changing parent history", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-branch-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const harness = createInMemorySessionLifecycleHarness();

  try {
    const lifecycle = harness.createLifecycle({ stateRoot, workspaceRoot });
    const parent = await lifecycle.create({ targetIdentity });
    const parentBefore = await lifecycle.inspect({ sessionId: parent.sessionId });

    const child = await lifecycle.branch({
      parentSessionId: parent.sessionId,
      atSequence: 1,
    });
    const parentAfter = await lifecycle.inspect({ sessionId: parent.sessionId });
    const inspectedChild = await lifecycle.inspect({ sessionId: child.sessionId });

    expect({ parentAfter, child, inspectedChild }).toEqual({
      parentAfter: parentBefore,
      child: {
        schemaVersion: 3,
        sessionId: expect.not.stringMatching(parent.sessionId),
        projectId: parent.projectId,
        targetIdentity,
        status: "idle",
        lastSequence: 1,
        promptContext: parent.promptContext,
        skillContext: parent.skillContext,
        lineage: {
          parentSessionId: parent.sessionId,
          parentEventPosition: 1,
          prefixDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
      },
      inspectedChild: child,
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle continues a branch from its referenced parent context", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-branch-context-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const requests: ModelMessage[][] = [];
  const driver = new FakeModelDriver((request) => {
    requests.push([...request.messages]);
    const latest = request.messages.at(-1);
    const answer =
      latest?.role === "user" && latest.content === "Parent prompt"
        ? "Parent answer"
        : "Child answer";
    return [
      { type: "text_delta", text: answer },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();

  try {
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const parent = await lifecycle.create({ targetIdentity });
    const parentRun = await lifecycle.continue({
      sessionId: parent.sessionId,
      input: { text: "Parent prompt" },
    });
    const branchBoundary = parentRun.snapshot.lastSequence;
    const child = await lifecycle.branch({
      parentSessionId: parent.sessionId,
      atSequence: branchBoundary,
    });

    const childRun = await lifecycle.continue({
      sessionId: child.sessionId,
      input: { text: "Child prompt" },
    });

    expect({
      result: childRun.result,
      childRequest: requests[1],
      childLineage: child.lineage,
    }).toEqual({
      result: { status: "completed", answer: "Child answer" },
      childRequest: [
        { role: "system", content: basePrompt },
        { role: "developer", content: skillUsagePrompt },
        { role: "user", content: "Parent prompt" },
        { role: "assistant", content: "Parent answer", toolCalls: [] },
        { role: "user", content: "Child prompt" },
      ],
      childLineage: expect.objectContaining({ parentEventPosition: branchBoundary }),
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle retains inherited branch context across a cold continuation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-branch-cold-context-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const requests: ModelMessage[][] = [];
  const driver = new FakeModelDriver((request) => {
    requests.push([...request.messages]);
    const answer = requests.length === 1 ? "Parent answer" : "Recovered child answer";
    return [
      { type: "text_delta", text: answer },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const root = await lifecycle.create({ targetIdentity });
    const rootRun = await lifecycle.continue({
      sessionId: root.sessionId,
      input: { text: "Parent prompt" },
    });
    const child = await lifecycle.branch({
      parentSessionId: root.sessionId,
      atSequence: rootRun.snapshot.lastSequence,
    });
    const runId = "123e4567-e89b-42d3-a456-426614174097";
    const store = await harness.sessions.open(child.sessionId);
    if (store === undefined) {
      throw new Error("Expected the child session store.");
    }
    const records: readonly Omit<
      Extract<SessionRecord, { readonly schemaVersion: 3 }>,
      "sequence"
    >[] = [
      {
        schemaVersion: 3,
        record: { type: "logical_run_started", runId, userMessage: "Child prompt" },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Child prompt" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(child, [
            { role: "user", content: "Parent prompt" },
            { role: "assistant", content: "Parent answer", toolCalls: [] },
            { role: "user", content: "Child prompt" },
          ]),
        },
      },
      {
        schemaVersion: 3,
        record: { type: "runtime_event", runId, event: { type: "model_message_started" } },
      },
    ];
    for (const [index, record] of records.entries()) {
      await store.append({ ...record, sequence: index + 2 } as SessionRecord);
    }

    const continued = await lifecycle.continue({ sessionId: child.sessionId });

    expect({ result: continued.result, childRequest: requests[1] }).toEqual({
      result: { status: "completed", answer: "Recovered child answer" },
      childRequest: [
        { role: "system", content: basePrompt },
        { role: "developer", content: skillUsagePrompt },
        { role: "user", content: "Parent prompt" },
        { role: "assistant", content: "Parent answer", toolCalls: [] },
        { role: "user", content: "Child prompt" },
      ],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle branches to an explicit compatible exact target only when it is ready", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-retarget-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () =>
      new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
  });
  const currentTargetIdentity = { ...targetIdentity, profileVersion: 3 };
  const harness = createInMemorySessionLifecycleHarness();

  try {
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const parent = await lifecycle.create({ targetIdentity: currentTargetIdentity });
    const parentRun = await lifecycle.continue({
      sessionId: parent.sessionId,
      input: { text: "Establish compatible DeepSeek history" },
    });

    const child = await lifecycle.branch({
      parentSessionId: parent.sessionId,
      atSequence: parentRun.snapshot.lastSequence,
      targetId: "deepseek-v4-pro.direct",
    });

    expect(child).toEqual({
      schemaVersion: 3,
      sessionId: expect.any(String),
      projectId: parent.projectId,
      targetIdentity: {
        ...currentTargetIdentity,
        targetId: "deepseek-v4-pro.direct",
        modelId: "deepseek-v4-pro",
      },
      status: "idle",
      lastSequence: 1,
      promptContext: parent.promptContext,
      skillContext: parent.skillContext,
      lineage: {
        parentSessionId: parent.sessionId,
        parentEventPosition: parentRun.snapshot.lastSequence,
        prefixDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects an incompatible retarget hidden behind an empty branch", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-nested-retarget-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const incompatibleTarget: ModelTargetIdentity = {
    ...targetIdentity,
    targetId: "other-model.direct",
    vendor: "other-vendor",
    modelId: "other-model",
  };
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "Root answer" },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
          {
            identity: incompatibleTarget,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const root = await lifecycle.create({ targetIdentity });
    const rootRun = await lifecycle.continue({
      sessionId: root.sessionId,
      input: { text: "Establish root history" },
    });
    const child = await lifecycle.branch({
      parentSessionId: root.sessionId,
      atSequence: rootRun.snapshot.lastSequence,
    });

    await expect(
      lifecycle.branch({
        parentSessionId: child.sessionId,
        atSequence: 1,
        targetId: incompatibleTarget.targetId,
      }),
    ).rejects.toMatchObject({ code: "session_model_target_incompatible" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle normalizes an active provider attempt before branching its complete tail", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-branch-interrupted-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ stateRoot, workspaceRoot });
    const parent = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174050";
    const store = await harness.sessions.open(parent.sessionId);
    if (store === undefined) {
      throw new Error("Expected the parent session store.");
    }
    await store.append({
      schemaVersion: 3,
      sequence: 2,
      record: { type: "logical_run_started", runId, userMessage: "Interrupted branch" },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 3,
      record: {
        type: "runtime_event",
        runId,
        event: { type: "user_message", text: "Interrupted branch" },
      },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 4,
      record: {
        type: "provider_attempt_started",
        runId,
        turn: 1,
        attempt: 1,
        targetIdentity,
        promptProjection: promptProjectionFor(parent, "Interrupted branch"),
      },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 5,
      record: {
        type: "runtime_event",
        runId,
        event: { type: "model_message_started" },
      },
    });

    const child = await lifecycle.branch({ parentSessionId: parent.sessionId, atSequence: 5 });
    const parentAfter = await lifecycle.inspect({ sessionId: parent.sessionId });

    expect({ child, parentAfter }).toEqual({
      child: expect.objectContaining({
        lineage: expect.objectContaining({
          parentSessionId: parent.sessionId,
          parentEventPosition: 6,
        }),
      }),
      parentAfter: expect.objectContaining({
        status: "interrupted",
        lastSequence: 6,
        run: expect.objectContaining({
          lastAttempt: { turn: 1, attempt: 1, status: "interrupted" },
        }),
      }),
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle recursively rejects a branch chain whose immutable ancestor prefix changed", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-branch-lineage-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);

  try {
    const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
    const root = await lifecycle.create({ targetIdentity });
    const child = await lifecycle.branch({ parentSessionId: root.sessionId, atSequence: 1 });
    const grandchild = await lifecycle.branch({
      parentSessionId: child.sessionId,
      atSequence: 1,
    });
    const rootPath = join(
      stateRoot,
      "projects",
      root.projectId.replace(/^sha256:/u, ""),
      "sessions",
      `${root.sessionId}.jsonl`,
    );
    const rootRecord = JSON.parse((await readFile(rootPath, "utf8")).trim()) as SessionRecord;
    if (rootRecord.schemaVersion !== 3 || rootRecord.record.type !== "session_genesis") {
      throw new Error("Expected a v3 root genesis.");
    }
    await writeFile(
      rootPath,
      `${JSON.stringify({
        ...rootRecord,
        record: {
          ...rootRecord.record,
          targetIdentity: { ...rootRecord.record.targetIdentity, modelId: "tampered-model" },
        },
      })}\n`,
      "utf8",
    );

    await expect(lifecycle.inspect({ sessionId: grandchild.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle branches completed failed and cancelled runs without reopening them", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-terminal-branch-"));
  const stateRoot = join(testRoot, "state");
  const failedWorkspace = join(testRoot, "failed-workspace");
  const cancelledWorkspace = join(testRoot, "cancelled-workspace");
  await mkdir(failedWorkspace);
  await mkdir(cancelledWorkspace);

  try {
    const failingTargets = createModelTargets({
      environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
      fetch: async () => {
        throw new Error("provider offline");
      },
    });
    const failedHarness = createInMemorySessionLifecycleHarness();
    const failedLifecycle = failedHarness.createLifecycle({
      modelTargets: failingTargets,
      stateRoot,
      workspaceRoot: failedWorkspace,
    });
    const failedParent = await failedLifecycle.create({ targetIdentity });
    const failedRun = await failedLifecycle.continue({
      sessionId: failedParent.sessionId,
      input: { text: "Fail after the attempt starts" },
    });
    const failedChild = await failedLifecycle.branch({
      parentSessionId: failedParent.sessionId,
      atSequence: failedRun.snapshot.lastSequence,
    });

    let markProviderStarted: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const cancellingDriver: ModelDriver = {
      async *stream(request) {
        markProviderStarted?.();
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) {
            resolve();
          } else {
            request.signal.addEventListener("abort", () => resolve(), { once: true });
          }
        });
      },
    };
    const cancellingTargets: ModelTargets = {
      async resolve() {
        return {
          identity: targetIdentity,
          driver: cancellingDriver,
          contextProfile: testContextProfile,
        };
      },
      async snapshot() {
        return {
          targets: [
            {
              identity: targetIdentity,
              readiness: { status: "available", credentialSource: "deterministic test adapter" },
              contextProfile: testContextProfile,
            },
          ],
        };
      },
    };
    const cancelledHarness = createInMemorySessionLifecycleHarness();
    const cancelledLifecycle = cancelledHarness.createLifecycle({
      modelTargets: cancellingTargets,
      stateRoot,
      workspaceRoot: cancelledWorkspace,
    });
    const cancelledParent = await cancelledLifecycle.create({ targetIdentity });
    const controller = new AbortController();
    const cancellingRun = cancelledLifecycle.continue({
      sessionId: cancelledParent.sessionId,
      input: { text: "Cancel after the attempt starts" },
      signal: controller.signal,
    });
    await providerStarted;
    controller.abort();
    const cancelledRun = await cancellingRun;
    const cancelledChild = await cancelledLifecycle.branch({
      parentSessionId: cancelledParent.sessionId,
      atSequence: cancelledRun.snapshot.lastSequence,
    });

    expect({ failedRun, failedChild, cancelledRun, cancelledChild }).toEqual({
      failedRun: expect.objectContaining({
        result: expect.objectContaining({ status: "failed" }),
        snapshot: expect.objectContaining({
          status: "settled",
          run: expect.objectContaining({
            lastAttempt: { turn: 1, attempt: 1, status: "interrupted" },
          }),
        }),
      }),
      failedChild: expect.objectContaining({
        status: "idle",
        lineage: expect.objectContaining({ parentSessionId: failedParent.sessionId }),
      }),
      cancelledRun: expect.objectContaining({
        result: expect.objectContaining({ status: "cancelled" }),
        snapshot: expect.objectContaining({
          status: "settled",
          run: expect.objectContaining({
            lastAttempt: { turn: 1, attempt: 1, status: "interrupted" },
          }),
        }),
      }),
      cancelledChild: expect.objectContaining({
        status: "idle",
        lineage: expect.objectContaining({ parentSessionId: cancelledParent.sessionId }),
      }),
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a session copied across canonical project roots", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-cross-project-"));
  const stateRoot = join(testRoot, "state");
  const sourceWorkspace = join(testRoot, "source-workspace");
  const otherWorkspace = join(testRoot, "other-workspace");
  await mkdir(sourceWorkspace);
  await mkdir(otherWorkspace);

  try {
    const source = await createSessionLifecycle({
      stateRoot,
      workspaceRoot: sourceWorkspace,
    }).create({ targetIdentity });
    const sourcePath = join(
      stateRoot,
      "projects",
      source.projectId.replace(/^sha256:/u, ""),
      "sessions",
      `${source.sessionId}.jsonl`,
    );
    const otherGenesis = await createSessionLifecycle({
      stateRoot,
      workspaceRoot: otherWorkspace,
    }).create({ targetIdentity });
    const copiedPath = join(
      stateRoot,
      "projects",
      otherGenesis.projectId.replace(/^sha256:/u, ""),
      "sessions",
      `${source.sessionId}.jsonl`,
    );
    await writeFile(copiedPath, await readFile(sourcePath, "utf8"), "utf8");

    await expect(
      createSessionLifecycle({ stateRoot, workspaceRoot: otherWorkspace }).inspect({
        sessionId: source.sessionId,
      }),
    ).rejects.toMatchObject({ code: "session_project_mismatch" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle durably completes a canonical provider response while keeping deltas live-only", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-response-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () =>
      new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
  });

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const events: RuntimeEvent[] = [];
    lifecycle.subscribe((event) => events.push(event));

    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Introduce yourself" },
      limits: { maxTurns: 2, maxTokens: 100 },
    });
    const inspected = await harness.createLifecycle({ stateRoot, workspaceRoot }).inspect({
      sessionId: created.sessionId,
    });

    expect({ continued, inspected, events }).toEqual({
      continued: {
        result: { status: "completed", answer: "Hello, Adam." },
        snapshot: inspected,
      },
      inspected: {
        ...snapshotWithLastPromptProjection(created, introductionRequestDigest),
        status: "settled",
        lastSequence: 9,
        run: {
          runId: expect.any(String),
          status: "settled",
          result: { status: "completed", answer: "Hello, Adam." },
          lastAttempt: { turn: 1, attempt: 1, status: "completed" },
          lastCompletedResponse: {
            turn: 1,
            attempt: 1,
            finishReason: "stop",
          },
        },
      },
      events: [
        { type: "user_message", text: "Introduce yourself" },
        { type: "model_message_started" },
        { type: "model_message_delta", text: "Hello, Adam." },
        {
          type: "model_usage",
          inputTokens: 7,
          outputTokens: 3,
          totalTokens: 10,
        },
        {
          type: "context_usage",
          ordinary: {
            inputTokens: 7,
            outputTokens: 3,
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
          active: { source: "provider_reported", tokens: 7, throughSequence: 6 },
        },
        { type: "model_message_completed", text: "Hello, Adam." },
        {
          type: "session_settled",
          result: { status: "completed", answer: "Hello, Adam." },
        },
      ],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle projects provider context usage through a cold child lineage", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-context-lineage-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "Lineage answer." },
    { type: "usage", inputTokens: 23_456, outputTokens: 101 },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const parent = await lifecycle.create({ targetIdentity });
    const completed = await lifecycle.continue({
      sessionId: parent.sessionId,
      input: { text: "Record context before branching" },
    });
    const child = await lifecycle.branch({
      parentSessionId: parent.sessionId,
      atSequence: completed.snapshot.lastSequence,
    });
    await lifecycle.close();

    const cold = harness.createLifecycle({ stateRoot, workspaceRoot });
    await expect(cold.inspectContextUsage({ sessionId: child.sessionId })).resolves.toEqual({
      ordinaryUsage: {
        inputTokens: 23_456,
        outputTokens: 101,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        cacheMissInputTokens: 0,
        unknownCalls: 0,
      },
      compactionUsage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        cacheMissInputTokens: 0,
        unknownCalls: 0,
      },
      active: { source: "provider_reported", tokens: 23_456 },
    });
    await cold.close();
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle counts an ordinary provider attempt without usage as unknown", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-context-unknown-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "Usage unavailable." },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Return no usage event" },
    });

    await expect(lifecycle.inspectContextUsage({ sessionId: created.sessionId })).resolves.toEqual({
      ordinaryUsage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        cacheMissInputTokens: 0,
        unknownCalls: 1,
      },
      compactionUsage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        cacheMissInputTokens: 0,
        unknownCalls: 0,
      },
      active: { source: "unknown" },
    });
    await lifecycle.close();
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle does not retain provider usage after a later interrupted attempt", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-context-stale-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "First answer." },
    { type: "usage", inputTokens: 12_345, outputTokens: 99 },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const completed = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Return provider usage" },
    });
    const runId = "123e4567-e89b-42d3-a456-426614174098";
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const records: readonly Omit<
      Extract<SessionRecord, { readonly schemaVersion: 3 }>,
      "sequence"
    >[] = [
      {
        schemaVersion: 3,
        record: { type: "logical_run_started", runId, userMessage: "Interrupt later" },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Interrupt later" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(created, [
            { role: "user", content: "Return provider usage" },
            { role: "assistant", content: "First answer.", toolCalls: [] },
            { role: "user", content: "Interrupt later" },
          ]),
        },
      },
      {
        schemaVersion: 3,
        record: { type: "runtime_event", runId, event: { type: "model_message_started" } },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "session_interrupted", reason: "cancelled" },
        },
      },
    ];
    for (const [index, record] of records.entries()) {
      await store.append({
        ...record,
        sequence: completed.snapshot.lastSequence + index + 1,
      } as SessionRecord);
    }

    await lifecycle.resume({ sessionId: created.sessionId });

    await expect(lifecycle.inspectContextUsage({ sessionId: created.sessionId })).resolves.toEqual({
      ordinaryUsage: {
        inputTokens: 12_345,
        outputTokens: 99,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        cacheMissInputTokens: 0,
        unknownCalls: 1,
      },
      compactionUsage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        cacheMissInputTokens: 0,
        unknownCalls: 0,
      },
      active: { source: "unknown" },
    });
    await lifecycle.close();
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle continues a run that crashed before its first provider attempt", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-pre-attempt-recovery-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () =>
      new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
  });

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174097";
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    await store.append({
      schemaVersion: 3,
      sequence: 2,
      record: { type: "logical_run_started", runId, userMessage: "Recover before sampling" },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 3,
      record: {
        type: "runtime_event",
        runId,
        event: { type: "user_message", text: "Recover before sampling" },
      },
    });

    const hydrated = await lifecycle.resume({ sessionId: created.sessionId });
    const continued = await lifecycle.continue({ sessionId: created.sessionId });
    const records = await store.read();

    expect({
      hydrated,
      continued,
      userMessages: records.filter(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "runtime_event" &&
          record.record.event.type === "user_message",
      ),
    }).toEqual({
      hydrated: {
        status: "ready",
        snapshot: {
          ...created,
          status: "interrupted",
          lastSequence: 3,
          run: { runId, status: "interrupted" },
        },
      },
      continued: {
        result: { status: "completed", answer: "Hello, Adam." },
        snapshot: expect.objectContaining({
          status: "settled",
          run: expect.objectContaining({
            runId,
            lastAttempt: { turn: 1, attempt: 1, status: "completed" },
          }),
        }),
      },
      userMessages: [
        expect.objectContaining({
          record: expect.objectContaining({
            event: { type: "user_message", text: "Recover before sampling" },
          }),
        }),
      ],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle restores the canonical user event after a pre-event crash", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-pre-user-recovery-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () =>
      new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
  });

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174095";
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    await store.append({
      schemaVersion: 3,
      sequence: 2,
      record: { type: "logical_run_started", runId, userMessage: "Restore my event" },
    });

    const resumed = await lifecycle.resume({ sessionId: created.sessionId });
    const continued = await lifecycle.continue({ sessionId: created.sessionId });
    const records = await store.read();

    expect({
      resumed,
      continued,
      userMessages: records.filter(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "runtime_event" &&
          record.record.event.type === "user_message",
      ),
    }).toEqual({
      resumed: expect.objectContaining({
        status: "ready",
        snapshot: expect.objectContaining({ status: "interrupted", lastSequence: 3 }),
      }),
      continued: expect.objectContaining({
        result: { status: "completed", answer: "Hello, Adam." },
      }),
      userMessages: [
        expect.objectContaining({
          record: expect.objectContaining({
            event: { type: "user_message", text: "Restore my event" },
          }),
        }),
      ],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle terminalizes a durable cancellation instead of reopening its run", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-cancel-recovery-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let modelRequests = 0;
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () => {
      modelRequests += 1;
      return new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  });

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174096";
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const records: readonly Omit<
      Extract<SessionRecord, { readonly schemaVersion: 3 }>,
      "sequence"
    >[] = [
      {
        schemaVersion: 3,
        record: { type: "logical_run_started", runId, userMessage: "Cancel durably" },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Cancel durably" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(created, "Cancel durably"),
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_message_started" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "session_interrupted", reason: "cancelled" },
        },
      },
    ];
    for (const [index, record] of records.entries()) {
      await store.append({ ...record, sequence: index + 2 } as SessionRecord);
    }

    const resumed = await lifecycle.resume({ sessionId: created.sessionId });
    await expect(lifecycle.continue({ sessionId: created.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
    const durableRecords = await store.read();
    const contextUsage = await lifecycle.inspectContextUsage({ sessionId: created.sessionId });

    expect({
      contextUsage,
      resumed,
      modelRequests,
      terminalRecords: durableRecords.slice(-2),
    }).toEqual({
      contextUsage: {
        ordinaryUsage: {
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          cacheMissInputTokens: 0,
          unknownCalls: 1,
        },
        compactionUsage: {
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          cacheMissInputTokens: 0,
          unknownCalls: 0,
        },
        active: { source: "unknown" },
      },
      resumed: {
        status: "ready",
        snapshot: {
          ...snapshotWithLastPromptProjection(
            created,
            promptProjectionFor(created, "Cancel durably").requestProjectionDigest,
          ),
          status: "settled",
          lastSequence: 8,
          run: {
            runId,
            status: "settled",
            result: {
              status: "cancelled",
              error: { code: "session_cancelled", message: "The session was cancelled." },
            },
            lastAttempt: { turn: 1, attempt: 1, status: "interrupted" },
          },
        },
      },
      modelRequests: 0,
      terminalRecords: [
        expect.objectContaining({
          record: expect.objectContaining({ type: "provider_attempt_interrupted" }),
        }),
        expect.objectContaining({
          record: expect.objectContaining({
            event: {
              type: "session_settled",
              result: {
                status: "cancelled",
                error: { code: "session_cancelled", message: "The session was cancelled." },
              },
            },
          }),
        }),
      ],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle completes a durable run-terminal intent instead of starting another attempt", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-terminal-intent-recovery-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let modelRequests = 0;
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () => {
      modelRequests += 1;
      return new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  });

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174094";
    const terminalResult = {
      status: "failed",
      error: {
        code: "model_stream_incomplete",
        message: "The model stream ended without a finish event.",
      },
    } as const;
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const records: readonly Omit<
      Extract<SessionRecord, { readonly schemaVersion: 3 }>,
      "sequence"
    >[] = [
      {
        schemaVersion: 3,
        record: { type: "logical_run_started", runId, userMessage: "Finish terminalization" },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Finish terminalization" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(created, "Finish terminalization"),
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_message_started" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_interrupted",
          runId,
          turn: 1,
          attempt: 1,
          reason: "run_terminal",
          result: terminalResult,
        },
      },
    ];
    for (const [index, record] of records.entries()) {
      await store.append({ ...record, sequence: index + 2 } as SessionRecord);
    }

    const resumed = await lifecycle.resume({ sessionId: created.sessionId });
    await expect(lifecycle.continue({ sessionId: created.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });

    expect({ resumed, modelRequests }).toEqual({
      resumed: {
        status: "ready",
        snapshot: {
          ...snapshotWithLastPromptProjection(
            created,
            promptProjectionFor(created, "Finish terminalization").requestProjectionDigest,
          ),
          status: "settled",
          lastSequence: 7,
          run: {
            runId,
            status: "settled",
            result: terminalResult,
            lastAttempt: { turn: 1, attempt: 1, status: "interrupted" },
          },
        },
      },
      modelRequests: 0,
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle artifactizes replay-critical reasoning instead of truncating it", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-replay-overflow-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const oversizedReasoning = "r".repeat(512 * 1024 + 1);
  const driver = new FakeModelDriver([
    {
      type: "reasoning_start",
      id: "provider-reasoning-0",
      artifactType: "provider_reasoning",
    },
    { type: "reasoning_delta", id: "provider-reasoning-0", text: oversizedReasoning },
    { type: "reasoning_end", id: "provider-reasoning-0" },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Think too much" },
    });
    const completedResponses = await harness.sessions
      .open(created.sessionId)
      .then(async (store) =>
        store === undefined
          ? []
          : (await store.read()).filter(
              (record) =>
                record.schemaVersion === 3 && record.record.type === "model_response_completed",
            ),
      );

    expect(continued).toMatchObject({
      result: { status: "completed", answer: "" },
      snapshot: {
        status: "settled",
        run: { result: { status: "completed", answer: "" } },
      },
    });
    expect(completedResponses).toHaveLength(1);
    const completedResponse = completedResponses[0];
    if (
      completedResponse?.schemaVersion !== 3 ||
      completedResponse.record.type !== "model_response_completed" ||
      completedResponse.record.response.recordVersion !== 2 ||
      completedResponse.record.response.reasoning?.storage !== "artifact"
    ) {
      throw new Error("Expected artifact-backed replay-critical reasoning.");
    }
    expect(completedResponse.record.response.reasoning.reference.byteCount).toBe(
      Buffer.byteLength(oversizedReasoning, "utf8"),
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle classifies an oversized complete response batch as replay overflow", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-replay-batch-overflow-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const argumentsJson = JSON.stringify({ value: "x".repeat(350 * 1024) });
  const driver = new FakeModelDriver([
    ...["one", "two", "three"].flatMap((id) => [
      { type: "tool_call_start" as const, id, name: "unknown_tool" },
      { type: "tool_call_delta" as const, id, json: argumentsJson },
      { type: "tool_call_end" as const, id },
    ]),
    { type: "finish", reason: "tool_calls" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Return a large atomic response batch" },
    });

    expect(continued.result).toEqual({
      status: "failed",
      error: {
        code: "replay_envelope_too_large",
        message: "The complete model response exceeds the durable replay envelope limit.",
      },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle commits a complete tool response before permission resolution", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-tool-intent-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let requestCount = 0;
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () => {
      requestCount += 1;
      return new Response(
        requestCount === 1 ? reasoningToolDeepSeekStream : answerOnlyDeepSeekStream,
        {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        },
      );
    },
  });

  try {
    const tools = createReadToolRegistry({ workspaceRoot });
    const readTool = tools.resolve("read_file");
    if (readTool === undefined) {
      throw new Error("Expected the read_file tool.");
    }
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({
      modelTargets,
      stateRoot,
      workspaceRoot,
      tools,
      permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["read"] }),
    });
    const created = await lifecycle.create({ targetIdentity });
    let resolvePermission:
      | ((event: Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }>) => void)
      | undefined;
    const permissionRequested = new Promise<
      Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }>
    >((resolve) => {
      resolvePermission = resolve;
    });
    lifecycle.subscribe((event) => {
      if (event.type === "tool_permission_requested") {
        resolvePermission?.(event);
      }
    });

    const pendingContinue = lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Read the project name" },
      limits: { maxTurns: 2 },
    });
    const firstOutcome = await Promise.race([
      permissionRequested.then((event) => ({ type: "permission" as const, event })),
      pendingContinue.then((continued) => ({ type: "settled" as const, continued })),
    ]);
    if (firstOutcome.type === "settled") {
      throw new Error(
        `The run settled before requesting permission: ${JSON.stringify(firstOutcome.continued.result)}`,
      );
    }
    const permission = firstOutcome.event;
    const beforeDecision = await lifecycle.inspect({ sessionId: created.sessionId });
    const durableRecords = await harness.sessions
      .open(created.sessionId)
      .then((store) => store?.read() ?? []);
    const completedResponse = durableRecords.find(
      (record) => record.schemaVersion === 3 && record.record.type === "model_response_completed",
    );
    const decision = lifecycle.decidePermission({
      requestId: permission.requestId,
      decision: "deny",
    });
    const continued = await pendingContinue;

    expect({ beforeDecision, completedResponse, decision, continued, requestCount }).toEqual({
      beforeDecision: {
        ...snapshotWithLastPromptProjection(created, permissionRequestDigest),
        status: "interrupted",
        lastSequence: 12,
        run: {
          runId: expect.any(String),
          status: "interrupted",
          lastAttempt: { turn: 1, attempt: 1, status: "completed" },
          lastCompletedResponse: {
            turn: 1,
            attempt: 1,
            finishReason: "tool_calls",
          },
        },
      },
      completedResponse: expect.objectContaining({
        schemaVersion: 3,
        record: expect.objectContaining({
          response: expect.objectContaining({
            toolIntents: [
              {
                callId: "read-project",
                name: "read_file",
                argumentsDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
                effect: "read",
                definitionDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
                replay: "safe",
              },
            ],
          }),
        }),
      }),
      decision: { status: "accepted" },
      continued: {
        result: { status: "completed", answer: "Hello, Adam." },
        snapshot: expect.objectContaining({ status: "settled" }),
      },
      requestCount: 2,
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

const reasoningToolDeepSeekStream = `data: {"id":"reasoning-1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"reasoning_content":"I need ","tool_calls":[{"index":0,"id":"read-project","type":"function","function":{"name":"read_file","arguments":"{\\"pa"}}]},"finish_reason":null}]}

data: {"id":"reasoning-1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"reasoning_content":"the README.","tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}

data: {"id":"reasoning-1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash","choices":[],"usage":{"prompt_tokens":13,"completion_tokens":9,"total_tokens":22}}

data: [DONE]

`;

test("SessionLifecycle cold continuation interrupts the old attempt and reuses its run and budgets", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-cold-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () =>
      new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
  });

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174100";
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    await store.append({
      schemaVersion: 3,
      sequence: 2,
      record: {
        type: "logical_run_started",
        runId,
        userMessage: "Introduce yourself",
        limits: { maxTurns: 2, maxTokens: 100 },
      },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 3,
      record: {
        type: "runtime_event",
        runId,
        event: { type: "user_message", text: "Introduce yourself" },
      },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 4,
      record: {
        type: "provider_attempt_started",
        runId,
        turn: 1,
        attempt: 1,
        targetIdentity,
        promptProjection: promptProjectionFor(created, "Introduce yourself"),
      },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 5,
      record: {
        type: "runtime_event",
        runId,
        event: { type: "model_message_started" },
      },
    });

    const hydrated = await lifecycle.resume({ sessionId: created.sessionId });
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Replace the original request" },
      }),
    ).rejects.toMatchObject({ code: "session_invalid" });
    const events: RuntimeEvent[] = [];
    lifecycle.subscribe((event) => events.push(event));
    const continued = await lifecycle.continue({ sessionId: created.sessionId });

    expect({ hydrated, continued, events }).toEqual({
      hydrated: {
        status: "ready",
        snapshot: {
          ...snapshotWithLastPromptProjection(
            created,
            promptProjectionFor(created, "Introduce yourself").requestProjectionDigest,
          ),
          status: "interrupted",
          lastSequence: 6,
          run: {
            runId,
            status: "interrupted",
            lastAttempt: { turn: 1, attempt: 1, status: "interrupted" },
          },
        },
      },
      continued: {
        result: { status: "completed", answer: "Hello, Adam." },
        snapshot: {
          ...snapshotWithLastPromptProjection(created, introductionRequestDigest),
          status: "settled",
          lastSequence: 12,
          run: {
            runId,
            status: "settled",
            result: { status: "completed", answer: "Hello, Adam." },
            lastAttempt: { turn: 1, attempt: 2, status: "completed" },
            lastCompletedResponse: {
              turn: 1,
              attempt: 2,
              finishReason: "stop",
            },
          },
        },
      },
      events: [
        { type: "model_message_started" },
        { type: "model_message_delta", text: "Hello, Adam." },
        {
          type: "model_usage",
          inputTokens: 7,
          outputTokens: 3,
          totalTokens: 10,
        },
        {
          type: "context_usage",
          ordinary: {
            inputTokens: 7,
            outputTokens: 3,
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
          active: { source: "provider_reported", tokens: 7, throughSequence: 9 },
        },
        { type: "model_message_completed", text: "Hello, Adam." },
        {
          type: "session_settled",
          result: { status: "completed", answer: "Hello, Adam." },
        },
      ],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle retains reported token usage from an interrupted provider attempt", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-token-resume-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let modelWasCalled = false;
  const driver = new FakeModelDriver(() => {
    modelWasCalled = true;
    return [{ type: "finish", reason: "stop" }];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174101";
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const records: readonly Omit<
      Extract<SessionRecord, { readonly schemaVersion: 3 }>,
      "sequence"
    >[] = [
      {
        schemaVersion: 3,
        record: {
          type: "logical_run_started",
          runId,
          userMessage: "Use the remaining budget",
          limits: { maxTokens: 10 },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Use the remaining budget" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(created, "Use the remaining budget"),
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_message_started" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_usage", inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        },
      },
    ];
    for (const [index, record] of records.entries()) {
      await store.append({ ...record, sequence: index + 2 } as SessionRecord);
    }

    const continued = await lifecycle.continue({ sessionId: created.sessionId });

    expect({ result: continued.result, modelWasCalled }).toEqual({
      result: {
        status: "failed",
        error: {
          code: "token_limit_exceeded",
          message: "The run reached its provider-reported token limit.",
        },
      },
      modelWasCalled: false,
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle settles an exhausted durable tool response before replaying its effect", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-tool-budget-recovery-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "# Budget\n", "utf8");
  let modelRequests = 0;
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () => {
      modelRequests += 1;
      return new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  });

  try {
    const tools = createReadToolRegistry({ workspaceRoot });
    const readTool = tools.resolve("read_file");
    if (readTool === undefined) {
      throw new Error("Expected the read_file tool.");
    }
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      tools,
      workspaceRoot,
    });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174102";
    const call = {
      id: "read-after-budget",
      name: "read_file",
      argumentsJson: '{"path":"README.md"}',
    } as const;
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const records: readonly Omit<
      Extract<SessionRecord, { readonly schemaVersion: 3 }>,
      "sequence"
    >[] = [
      {
        schemaVersion: 3,
        record: {
          type: "logical_run_started",
          runId,
          userMessage: "Do not read after budget",
          limits: { maxTokens: 10 },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Do not read after budget" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(
            created,
            "Do not read after budget",
            tools.definitions(),
          ),
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_message_started" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_usage", inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "model_response_completed",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          response: {
            text: "",
            toolCalls: [call],
            toolIntents: [
              {
                callId: call.id,
                name: call.name,
                argumentsDigest: `sha256:${createHash("sha256")
                  .update(call.argumentsJson)
                  .digest("hex")}`,
                effect: "read",
                definitionDigest: `sha256:${"0".repeat(64)}`,
                replay: "safe",
              },
            ],
            finishReason: "tool_calls",
            usage: { inputTokens: 7, outputTokens: 3 },
          },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_message_completed", text: "" },
        },
      },
    ];
    for (const [index, record] of records.entries()) {
      await store.append({ ...record, sequence: index + 2 } as SessionRecord);
    }

    const resumed = await lifecycle.resume({ sessionId: created.sessionId });
    const durableRecords = await store.read();

    expect({
      resumed,
      modelRequests,
      toolEvents: durableRecords.filter(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "runtime_event" &&
          record.record.event.type.startsWith("tool_"),
      ),
    }).toEqual({
      resumed: expect.objectContaining({
        status: "ready",
        snapshot: expect.objectContaining({
          status: "settled",
          run: expect.objectContaining({
            result: {
              status: "failed",
              error: {
                code: "token_limit_exceeded",
                message: "The run reached its provider-reported token limit.",
              },
            },
          }),
        }),
      }),
      modelRequests: 0,
      toolEvents: [],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle settles a durable stop response with aggregate usage after restart", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-stop-recovery-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let modelRequests = 0;
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () => {
      modelRequests += 1;
      return new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  });

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174150";
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const records: readonly Omit<
      Extract<SessionRecord, { readonly schemaVersion: 3 }>,
      "sequence"
    >[] = [
      {
        schemaVersion: 3,
        record: {
          type: "logical_run_started",
          runId,
          userMessage: "Recover answer",
          limits: { maxTokens: 10 },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Recover answer" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(created, "Recover answer"),
        },
      },
      {
        schemaVersion: 3,
        record: { type: "runtime_event", runId, event: { type: "model_message_started" } },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_usage", inputTokens: 4, outputTokens: 2, totalTokens: 6 },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_usage", inputTokens: 2, outputTokens: 2, totalTokens: 4 },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "model_response_completed",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          response: {
            text: "Recovered answer.",
            toolCalls: [],
            toolIntents: [],
            finishReason: "stop",
            usage: { inputTokens: 2, outputTokens: 2 },
          },
        },
      },
    ];
    for (const [index, record] of records.entries()) {
      await store.append({ ...record, sequence: index + 2 } as SessionRecord);
    }

    const resumed = await lifecycle.resume({ sessionId: created.sessionId });

    expect({ modelRequests, resumed }).toEqual({
      modelRequests: 0,
      resumed: {
        status: "ready",
        snapshot: {
          ...snapshotWithLastPromptProjection(
            created,
            promptProjectionFor(created, "Recover answer").requestProjectionDigest,
          ),
          status: "settled",
          lastSequence: 10,
          run: {
            runId,
            status: "settled",
            result: {
              status: "failed",
              error: {
                code: "token_limit_exceeded",
                message: "The run reached its provider-reported token limit.",
              },
            },
            lastAttempt: { turn: 1, attempt: 1, status: "completed" },
            lastCompletedResponse: { turn: 1, attempt: 1, finishReason: "stop" },
          },
        },
      },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle cold continuation replays a completed safe read as context without executing it again", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-safe-read-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "# Adam Agent\n", "utf8");
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

  try {
    const tools = createReadToolRegistry({ workspaceRoot });
    const readTool = tools.resolve("read_file");
    if (readTool === undefined) {
      throw new Error("Expected the read_file tool.");
    }
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({
      modelTargets,
      stateRoot,
      workspaceRoot,
      tools,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174200";
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const records: readonly Omit<
      Extract<SessionRecord, { readonly schemaVersion: 3 }>,
      "sequence"
    >[] = [
      {
        schemaVersion: 3,
        record: {
          type: "logical_run_started",
          runId,
          userMessage: "Read the project name",
          limits: { maxTurns: 3, maxTokens: 100 },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Read the project name" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(
            created,
            "Read the project name",
            tools.definitions(),
          ),
        },
      },
      {
        schemaVersion: 3,
        record: { type: "runtime_event", runId, event: { type: "model_message_started" } },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_usage", inputTokens: 13, outputTokens: 9, totalTokens: 22 },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "model_response_completed",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          response: {
            text: "",
            reasoning: "I need the README.",
            toolCalls: [
              { id: "read-project", name: "read_file", argumentsJson: '{"path":"README.md"}' },
            ],
            toolIntents: [
              {
                callId: "read-project",
                name: "read_file",
                argumentsDigest: `sha256:${createHash("sha256")
                  .update('{"path":"README.md"}')
                  .digest("hex")}`,
                effect: "read",
                definitionDigest: readTool.definitionDigest,
                replay: "safe",
              },
            ],
            finishReason: "tool_calls",
            usage: { inputTokens: 13, outputTokens: 9 },
          },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_message_completed", text: "" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "tool_requested", callId: "read-project", name: "read_file" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: {
            type: "tool_permission_decided",
            callId: "read-project",
            name: "read_file",
            decision: "allow",
            effect: "read",
            scope: "call",
            subject: { type: "file", path: "README.md" },
          },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "tool_started", callId: "read-project", name: "read_file" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: {
            type: "tool_completed",
            callId: "read-project",
            name: "read_file",
            output: { path: "README.md", content: "# Adam Agent\n", truncated: false },
          },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 2,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(
            created,
            [
              { role: "user", content: "Read the project name" },
              {
                role: "assistant",
                content: "",
                reasoning: "I need the README.",
                toolCalls: [
                  {
                    id: "read-project",
                    name: "read_file",
                    argumentsJson: '{"path":"README.md"}',
                  },
                ],
              },
              {
                role: "tool",
                callId: "read-project",
                name: "read_file",
                result: {
                  status: "completed",
                  output: { path: "README.md", content: "# Adam Agent\n", truncated: false },
                },
              },
            ],
            tools.definitions(),
          ),
        },
      },
      {
        schemaVersion: 3,
        record: { type: "runtime_event", runId, event: { type: "model_message_started" } },
      },
    ];
    for (const [index, record] of records.entries()) {
      await store.append({ ...record, sequence: index + 2 } as SessionRecord);
    }

    const hydrated = await lifecycle.resume({ sessionId: created.sessionId });
    const events: RuntimeEvent[] = [];
    lifecycle.subscribe((event) => events.push(event));
    const continued = await lifecycle.continue({ sessionId: created.sessionId });
    const request = requests[0] as { readonly messages?: readonly unknown[] };

    expect({ hydrated, continued, request, toolEvents: events.filter(isToolEvent) }).toEqual({
      hydrated: expect.objectContaining({
        status: "ready",
        snapshot: expect.objectContaining({
          lastSequence: 15,
          run: expect.objectContaining({
            runId,
            lastAttempt: { turn: 2, attempt: 1, status: "interrupted" },
          }),
        }),
      }),
      continued: expect.objectContaining({
        result: { status: "completed", answer: "Hello, Adam." },
        snapshot: expect.objectContaining({
          lastSequence: 21,
          run: expect.objectContaining({
            runId,
            lastAttempt: { turn: 2, attempt: 2, status: "completed" },
          }),
        }),
      }),
      request: expect.objectContaining({
        messages: [
          { role: "system", content: basePrompt },
          { role: "system", content: `Developer instruction:\n${skillUsagePrompt}` },
          { role: "user", content: "Read the project name" },
          expect.objectContaining({
            role: "assistant",
            reasoning_content: "I need the README.",
          }),
          expect.objectContaining({ role: "tool", tool_call_id: "read-project" }),
        ],
      }),
      toolEvents: [],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle settles a started unsafe tool effect as indeterminate without replay", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-unsafe-tool-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let modelRequests = 0;
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () => {
      modelRequests += 1;
      return new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  });

  try {
    const tools = createMutationToolRegistry({ stateRoot, workspaceRoot });
    const writeTool = tools.resolve("write_file");
    if (writeTool === undefined) {
      throw new Error("Expected the write_file tool.");
    }
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["write"] }),
      stateRoot,
      tools,
      workspaceRoot,
    });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174300";
    const call = {
      id: "write-unsafe",
      name: "write_file",
      argumentsJson: '{"path":"unsafe.txt","content":"x"}',
    } as const;
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const records: readonly Omit<
      Extract<SessionRecord, { readonly schemaVersion: 3 }>,
      "sequence"
    >[] = [
      {
        schemaVersion: 3,
        record: { type: "logical_run_started", runId, userMessage: "Write unsafe.txt" },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Write unsafe.txt" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(created, "Write unsafe.txt", tools.definitions()),
        },
      },
      {
        schemaVersion: 3,
        record: { type: "runtime_event", runId, event: { type: "model_message_started" } },
      },
      {
        schemaVersion: 3,
        record: {
          type: "model_response_completed",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          response: {
            text: "",
            toolCalls: [call],
            toolIntents: [
              {
                callId: call.id,
                name: call.name,
                argumentsDigest: `sha256:${createHash("sha256")
                  .update(call.argumentsJson)
                  .digest("hex")}`,
                effect: "write",
                definitionDigest: writeTool.definitionDigest,
                replay: "never",
              },
            ],
            finishReason: "tool_calls",
          },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_message_completed", text: "" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "tool_requested", callId: call.id, name: call.name },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: {
            type: "tool_permission_decided",
            callId: call.id,
            name: call.name,
            decision: "allow",
            effect: "write",
            scope: "call",
            subject: { type: "file", path: "unsafe.txt" },
          },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "tool_started", callId: call.id, name: call.name },
        },
      },
    ];
    for (const [index, record] of records.entries()) {
      await store.append({ ...record, sequence: index + 2 } as SessionRecord);
    }

    const resumed = await lifecycle.resume({ sessionId: created.sessionId });
    const unsafeFileExists = await import("node:fs/promises").then(async ({ access }) =>
      access(join(workspaceRoot, "unsafe.txt")).then(
        () => true,
        () => false,
      ),
    );

    expect({ modelRequests, resumed, unsafeFileExists }).toEqual({
      modelRequests: 0,
      resumed: {
        status: "ready",
        snapshot: {
          ...snapshotWithLastPromptProjection(
            created,
            promptProjectionFor(created, "Write unsafe.txt", tools.definitions())
              .requestProjectionDigest,
          ),
          status: "settled",
          lastSequence: 12,
          run: {
            runId,
            status: "settled",
            result: {
              status: "failed",
              error: {
                code: "tool_effect_indeterminate",
                reason: "process_restart",
                message:
                  "The write_file effect started before restart and cannot be replayed safely.",
              },
            },
            lastAttempt: { turn: 1, attempt: 1, status: "completed" },
            lastCompletedResponse: { turn: 1, attempt: 1, finishReason: "tool_calls" },
          },
        },
      },
      unsafeFileExists: false,
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle explicitly replays one exact safe read after revalidating its durable allow", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-safe-replay-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "# Safe replay\n", "utf8");
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

  try {
    const tools = createReadToolRegistry({ workspaceRoot });
    const readTool = tools.resolve("read_file");
    if (readTool === undefined) {
      throw new Error("Expected the read_file tool.");
    }
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      tools,
      workspaceRoot,
    });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174400";
    const call = {
      id: "read-after-restart",
      name: "read_file",
      argumentsJson: '{"path":"README.md"}',
    } as const;
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const records: readonly Omit<
      Extract<SessionRecord, { readonly schemaVersion: 3 }>,
      "sequence"
    >[] = [
      {
        schemaVersion: 3,
        record: { type: "logical_run_started", runId, userMessage: "Read the project" },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Read the project" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(created, "Read the project", tools.definitions()),
        },
      },
      {
        schemaVersion: 3,
        record: { type: "runtime_event", runId, event: { type: "model_message_started" } },
      },
      {
        schemaVersion: 3,
        record: {
          type: "model_response_completed",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          response: {
            text: "",
            reasoning: "I need the file.",
            toolCalls: [call],
            toolIntents: [
              {
                callId: call.id,
                name: call.name,
                argumentsDigest: `sha256:${createHash("sha256")
                  .update(call.argumentsJson)
                  .digest("hex")}`,
                effect: "read",
                definitionDigest: readTool.definitionDigest,
                replay: "safe",
              },
            ],
            finishReason: "tool_calls",
          },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_message_completed", text: "" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "tool_requested", callId: call.id, name: call.name },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: {
            type: "tool_permission_decided",
            callId: call.id,
            name: call.name,
            decision: "allow",
            effect: "read",
            scope: "call",
            subject: { type: "file", path: "README.md" },
          },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "tool_started", callId: call.id, name: call.name },
        },
      },
    ];
    for (const [index, record] of records.entries()) {
      await store.append({ ...record, sequence: index + 2 } as SessionRecord);
    }

    const hydrated = await lifecycle.resume({ sessionId: created.sessionId });
    const continued = await lifecycle.continue({ sessionId: created.sessionId });
    const persisted = await store.read();
    const publicToolEvents = persisted.flatMap((record) =>
      record.schemaVersion === 3 &&
      record.record.type === "runtime_event" &&
      record.record.event.type.startsWith("tool_")
        ? [record.record.event]
        : [],
    );

    expect({ hydrated, continued, requests, publicToolEvents }).toEqual({
      hydrated: expect.objectContaining({
        status: "ready",
        snapshot: expect.objectContaining({ status: "interrupted", lastSequence: 10 }),
      }),
      continued: expect.objectContaining({
        result: { status: "completed", answer: "Hello, Adam." },
        snapshot: expect.objectContaining({
          status: "settled",
          run: expect.objectContaining({
            runId,
            lastAttempt: { turn: 2, attempt: 1, status: "completed" },
          }),
        }),
      }),
      requests: [
        expect.objectContaining({
          messages: [
            { role: "system", content: basePrompt },
            { role: "system", content: `Developer instruction:\n${skillUsagePrompt}` },
            { role: "user", content: "Read the project" },
            expect.objectContaining({
              role: "assistant",
              reasoning_content: "I need the file.",
            }),
            expect.objectContaining({ role: "tool", tool_call_id: call.id }),
          ],
        }),
      ],
      publicToolEvents: [
        { type: "tool_requested", callId: call.id, name: call.name },
        {
          type: "tool_permission_decided",
          callId: call.id,
          name: call.name,
          decision: "allow",
          effect: "read",
          scope: "call",
          subject: { type: "file", path: "README.md" },
        },
        { type: "tool_started", callId: call.id, name: call.name },
        {
          type: "tool_completed",
          callId: call.id,
          name: call.name,
          output: { path: "README.md", content: "# Safe replay\n", truncated: false },
        },
      ],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle asks again after restart instead of restoring a pending permission as approval", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-pending-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "# Pending\n", "utf8");
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

  try {
    const tools = createReadToolRegistry({ workspaceRoot });
    const readTool = tools.resolve("read_file");
    if (readTool === undefined) {
      throw new Error("Expected the read_file tool.");
    }
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["read"] }),
      stateRoot,
      tools,
      workspaceRoot,
    });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174500";
    const call = {
      id: "read-pending",
      name: "read_file",
      argumentsJson: '{"path":"README.md"}',
    } as const;
    const requestId = `${runId}:${call.id}`;
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const records: readonly Omit<
      Extract<SessionRecord, { readonly schemaVersion: 3 }>,
      "sequence"
    >[] = [
      {
        schemaVersion: 3,
        record: { type: "logical_run_started", runId, userMessage: "Read pending" },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Read pending" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(created, "Read pending", tools.definitions()),
        },
      },
      {
        schemaVersion: 3,
        record: { type: "runtime_event", runId, event: { type: "model_message_started" } },
      },
      {
        schemaVersion: 3,
        record: {
          type: "model_response_completed",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          response: {
            text: "",
            toolCalls: [call],
            toolIntents: [
              {
                callId: call.id,
                name: call.name,
                argumentsDigest: `sha256:${createHash("sha256")
                  .update(call.argumentsJson)
                  .digest("hex")}`,
                effect: "read",
                definitionDigest: readTool.definitionDigest,
                replay: "safe",
              },
            ],
            finishReason: "tool_calls",
          },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_message_completed", text: "" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "tool_requested", callId: call.id, name: call.name },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: {
            type: "tool_permission_requested",
            requestId,
            callId: call.id,
            name: call.name,
            effect: "read",
            scope: "call",
            subject: { type: "file", path: "README.md" },
          },
        },
      },
    ];
    for (const [index, record] of records.entries()) {
      await store.append({ ...record, sequence: index + 2 } as SessionRecord);
    }
    let resolvePermission:
      | ((event: Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }>) => void)
      | undefined;
    const askedAgain = new Promise<
      Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }>
    >((resolve) => {
      resolvePermission = resolve;
    });
    lifecycle.subscribe((event) => {
      if (event.type === "tool_permission_requested") {
        resolvePermission?.(event);
      }
    });

    const hydrated = await lifecycle.resume({ sessionId: created.sessionId });
    const continuing = lifecycle.continue({ sessionId: created.sessionId });
    const repeatedPermission = await askedAgain;
    const decision = lifecycle.decidePermission({
      requestId: repeatedPermission.requestId,
      decision: "deny",
    });
    const continued = await continuing;

    expect({ hydrated, repeatedPermission, decision, continued, requests }).toEqual({
      hydrated: expect.objectContaining({
        status: "ready",
        snapshot: expect.objectContaining({ status: "interrupted" }),
      }),
      repeatedPermission: {
        type: "tool_permission_requested",
        requestId,
        callId: call.id,
        name: call.name,
        effect: "read",
        scope: "call",
        subject: { type: "file", path: "README.md" },
      },
      decision: { status: "accepted" },
      continued: expect.objectContaining({
        result: { status: "completed", answer: "Hello, Adam." },
      }),
      requests: [
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({ role: "tool", tool_call_id: call.id }),
          ]),
        }),
      ],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each([
  {
    label: "mismatched tool definition before start",
    currentTool: true,
    storedDefinitionMatches: false,
    started: false,
  },
])(
  "SessionLifecycle settles safe work with an $label as indeterminate",
  async ({ currentTool, storedDefinitionMatches, started }) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-tool-matrix-"));
    const stateRoot = join(testRoot, "state");
    const workspaceRoot = join(testRoot, "workspace");
    await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, "README.md"), "# Matrix\n", "utf8");
    let modelRequests = 0;
    const modelTargets = createModelTargets({
      environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
      fetch: async () => {
        modelRequests += 1;
        return new Response(answerOnlyDeepSeekStream, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        });
      },
    });

    try {
      const tools = createReadToolRegistry({ workspaceRoot });
      const readTool = tools.resolve("read_file");
      if (readTool === undefined) {
        throw new Error("Expected the read_file tool.");
      }
      const harness = createInMemorySessionLifecycleHarness();
      const lifecycle = harness.createLifecycle({
        modelTargets,
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
        stateRoot,
        ...(currentTool ? { tools } : {}),
        workspaceRoot,
      });
      const created = await lifecycle.create({ targetIdentity });
      const runId = "123e4567-e89b-42d3-a456-426614174510";
      const call = {
        id: "read-matrix",
        name: "read_file",
        argumentsJson: '{"path":"README.md"}',
      } as const;
      const store = await harness.sessions.open(created.sessionId);
      if (store === undefined) {
        throw new Error("Expected the created session store.");
      }
      const records: readonly Omit<
        Extract<SessionRecord, { readonly schemaVersion: 3 }>,
        "sequence"
      >[] = [
        {
          schemaVersion: 3,
          record: { type: "logical_run_started", runId, userMessage: "Read with matrix" },
        },
        {
          schemaVersion: 3,
          record: {
            type: "runtime_event",
            runId,
            event: { type: "user_message", text: "Read with matrix" },
          },
        },
        {
          schemaVersion: 3,
          record: {
            type: "provider_attempt_started",
            runId,
            turn: 1,
            attempt: 1,
            targetIdentity,
            promptProjection: promptProjectionFor(
              created,
              "Read with matrix",
              currentTool ? tools.definitions() : [],
            ),
          },
        },
        {
          schemaVersion: 3,
          record: {
            type: "runtime_event",
            runId,
            event: { type: "model_message_started" },
          },
        },
        {
          schemaVersion: 3,
          record: {
            type: "model_response_completed",
            runId,
            turn: 1,
            attempt: 1,
            targetIdentity,
            response: {
              text: "",
              toolCalls: [call],
              toolIntents: [
                {
                  callId: call.id,
                  name: call.name,
                  argumentsDigest: `sha256:${createHash("sha256")
                    .update(call.argumentsJson)
                    .digest("hex")}`,
                  effect: "read",
                  definitionDigest: storedDefinitionMatches
                    ? readTool.definitionDigest
                    : `sha256:${"0".repeat(64)}`,
                  replay: "safe",
                },
              ],
              finishReason: "tool_calls",
            },
          },
        },
        {
          schemaVersion: 3,
          record: {
            type: "runtime_event",
            runId,
            event: { type: "model_message_completed", text: "" },
          },
        },
        {
          schemaVersion: 3,
          record: {
            type: "runtime_event",
            runId,
            event: { type: "tool_requested", callId: call.id, name: call.name },
          },
        },
        ...(started
          ? ([
              {
                schemaVersion: 3,
                record: {
                  type: "runtime_event",
                  runId,
                  event: {
                    type: "tool_permission_decided",
                    callId: call.id,
                    name: call.name,
                    decision: "allow",
                    effect: "read",
                    scope: "call",
                    subject: { type: "file", path: "README.md" },
                  },
                },
              },
              {
                schemaVersion: 3,
                record: {
                  type: "runtime_event",
                  runId,
                  event: { type: "tool_started", callId: call.id, name: call.name },
                },
              },
            ] satisfies readonly Omit<
              Extract<SessionRecord, { readonly schemaVersion: 3 }>,
              "sequence"
            >[])
          : []),
      ];
      for (const [index, record] of records.entries()) {
        await store.append({ ...record, sequence: index + 2 } as SessionRecord);
      }

      const resumed = await lifecycle.resume({ sessionId: created.sessionId });

      expect({ modelRequests, resumed }).toEqual({
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
                  message: started
                    ? "The read_file effect started before restart and cannot be replayed safely."
                    : "The durable read_file request no longer matches the current tool definition and requires inspection.",
                },
              },
            }),
          }),
        }),
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test("SessionLifecycle rejects an incomplete canonical tool response from untrusted history", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-incomplete-response-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);

  try {
    const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174511";
    const store = await openJsonlSessionStore<SessionRecord>({
      stateRoot,
      workspaceRoot,
      sessionId: created.sessionId,
    });
    await store.append({
      schemaVersion: 3,
      sequence: 2,
      record: { type: "logical_run_started", runId, userMessage: "Incomplete response" },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 3,
      record: {
        type: "runtime_event",
        runId,
        event: { type: "user_message", text: "Incomplete response" },
      },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 4,
      record: {
        type: "provider_attempt_started",
        runId,
        turn: 1,
        attempt: 1,
        targetIdentity,
        promptProjection: promptProjectionFor(created, "Incomplete response"),
      },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 5,
      record: {
        type: "runtime_event",
        runId,
        event: { type: "model_message_started" },
      },
    });
    const sessionPath = join(
      stateRoot,
      "projects",
      created.projectId.replace(/^sha256:/u, ""),
      "sessions",
      `${created.sessionId}.jsonl`,
    );
    const incompleteRecord = {
      schemaVersion: 3,
      sequence: 6,
      record: {
        type: "model_response_completed",
        runId,
        turn: 1,
        attempt: 1,
        targetIdentity,
        response: {
          text: "",
          toolCalls: [
            { id: "incomplete-read", name: "read_file", argumentsJson: '{"path":"README.md"}' },
          ],
          toolIntents: [],
          finishReason: "tool_calls",
        },
      },
    };
    await writeFile(
      sessionPath,
      `${await readFile(sessionPath, "utf8")}${JSON.stringify(incompleteRecord)}\n`,
      "utf8",
    );

    await expect(lifecycle.inspect({ sessionId: created.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a title terminal record without its matching durable start", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-invalid-title-history-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    await store.append({
      schemaVersion: 3,
      sequence: 2,
      record: {
        type: "session_title_generation_completed",
        recordVersion: 1,
        generationId: "123e4567-e89b-42d3-a456-426614174512",
        title: "Fabricated title",
        usage: { status: "unknown" },
      },
    });

    await expect(lifecycle.inspect({ sessionId: created.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

function isToolEvent(event: RuntimeEvent): boolean {
  return event.type.startsWith("tool_");
}
