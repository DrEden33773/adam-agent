import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ContextProfile,
  createCodingToolRegistry,
  createModelTargets,
  createMutationToolRegistry,
  createPermissionPolicy,
  createReadToolRegistry,
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
  openJsonlSessionStore,
  type ProjectLifecycleOwner,
  ProjectLifecycleOwnerError,
  preparedDirectDeepSeekV2ContextProfile,
  type SessionRecord,
  sessionCloseDrainBarrier,
  sessionLogicalRunStartedBarrier,
  sessionProjectLifecycleOwner,
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
  "sha256:b8f5b0a402f635a8353c4f77a332c8acd7a44399820db9848a1f8d3678961adb" as const;
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
    profileVersion: 2,
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
  const policyTargetIdentity: ModelTargetIdentity = { ...targetIdentity, profileVersion: 2 };
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
  const policyTargetIdentity: ModelTargetIdentity = { ...targetIdentity, profileVersion: 2 };
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
  const policyTargetIdentity: ModelTargetIdentity = { ...targetIdentity, profileVersion: 2 };
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
  const policyTargetIdentity: ModelTargetIdentity = { ...targetIdentity, profileVersion: 2 };
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

test("SessionLifecycle creates a prompt-v3 genesis with an empty bounded Skill snapshot and six tools", async () => {
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
  const currentTargetIdentity = { ...targetIdentity, profileVersion: 2 };
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
