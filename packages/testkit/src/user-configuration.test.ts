import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ContextProfile,
  createPermissionPolicy,
  createPresentationSession,
  createReadToolRegistry,
  type ModelTargetIdentity,
  type ModelTargets,
  type PresentationPreferences,
} from "@adam-agent/agent";
import { createPresentationPreferencesWithStorageForTesting } from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { createInMemorySessionLifecycleHarness, FakeModelDriver } from "./index.js";

const targetIdentity: ModelTargetIdentity = {
  targetId: "deepseek-v4-flash.direct",
  vendor: "deepseek",
  modelId: "deepseek-v4-flash",
  route: "direct",
  profileVersion: 1,
  certification: "certified",
};

const alternateTargetIdentity: ModelTargetIdentity = {
  ...targetIdentity,
  targetId: "deepseek-v4-pro.direct",
  modelId: "deepseek-v4-pro",
};

const officialProfile: ContextProfile = {
  version: 1,
  contextWindowTokens: 1_000_000,
  maximumOutputTokens: 32_768,
  compactAtTokens: 800_000,
  postCompactTargetTokens: 200_000,
  retainedTargetTokens: 20_000,
  estimatorVersion: 1,
};

function createInMemoryUserConfiguration(initialText: string | null = null): {
  readonly preferences: PresentationPreferences;
  read(): string | null;
  replace(text: string | null): void;
} {
  let text = initialText;
  const preferences = createPresentationPreferencesWithStorageForTesting({
    async read() {
      return text === null ? { status: "missing" } : { status: "available", text };
    },
    async write(nextText) {
      text = nextText;
    },
  });
  return {
    preferences,
    read: () => text,
    replace(nextText) {
      text = nextText;
    },
  };
}

test("loading v1 preferences normalizes an empty model policy without rewriting the file", async () => {
  const original = `${JSON.stringify({
    schemaVersion: 1,
    defaultTargetId: targetIdentity.targetId,
  })}\n`;
  const configuration = createInMemoryUserConfiguration(original);

  expect({
    snapshot: await configuration.preferences.load(),
    bytes: configuration.read(),
  }).toEqual({
    snapshot: {
      defaultTargetId: targetIdentity.targetId,
      modelPolicy: {
        contextWindowTokens: null,
        maximumOutputTokens: null,
        automaticCompactionWindowTokens: null,
      },
      diagnostic: null,
    },
    bytes: original,
  });
});

test("an explicit model-policy mutation upgrades v1 to exact v2 while preserving the default", async () => {
  const configuration = createInMemoryUserConfiguration(
    `${JSON.stringify({ schemaVersion: 1, defaultTargetId: targetIdentity.targetId })}\n`,
  );
  await configuration.preferences.setModelPolicy({
    field: "maximumOutputTokens",
    value: 24_000,
  });

  const expected = {
    schemaVersion: 2,
    defaultTargetId: targetIdentity.targetId,
    modelPolicy: {
      contextWindowTokens: null,
      maximumOutputTokens: 24_000,
      automaticCompactionWindowTokens: null,
    },
  };
  expect({
    snapshot: await configuration.preferences.load(),
    bytes: configuration.read(),
  }).toEqual({
    snapshot: {
      defaultTargetId: targetIdentity.targetId,
      modelPolicy: expected.modelPolicy,
      diagnostic: null,
    },
    bytes: `${JSON.stringify(expected)}\n`,
  });
});

test("clearing the saved default preserves the exact v2 model policy", async () => {
  const original = {
    schemaVersion: 2,
    defaultTargetId: targetIdentity.targetId,
    modelPolicy: {
      contextWindowTokens: 800_000,
      maximumOutputTokens: 24_000,
      automaticCompactionWindowTokens: 650_000,
    },
  };
  const configuration = createInMemoryUserConfiguration(`${JSON.stringify(original)}\n`);
  await configuration.preferences.setDefaultTarget(null);

  const expected = { ...original, defaultTargetId: null };
  expect({
    snapshot: await configuration.preferences.load(),
    bytes: configuration.read(),
  }).toEqual({
    snapshot: {
      defaultTargetId: null,
      modelPolicy: original.modelPolicy,
      diagnostic: null,
    },
    bytes: `${JSON.stringify(expected)}\n`,
  });
});

test("a duplicate semantic v2 field is rejected instead of taking the last value", async () => {
  const configuration = createInMemoryUserConfiguration(
    '{"schemaVersion":2,"defaultTargetId":null,"modelPolicy":{"contextWindowTokens":null,"maximumOutputTokens":24000,"\\u006daximumOutputTokens":12000,"automaticCompactionWindowTokens":null}}\n',
  );
  await expect(configuration.preferences.load()).resolves.toEqual({
    defaultTargetId: null,
    modelPolicy: {
      contextWindowTokens: null,
      maximumOutputTokens: null,
      automaticCompactionWindowTokens: null,
    },
    diagnostic: {
      code: "target_configuration_invalid",
      message: "The saved default target configuration is invalid.",
    },
  });
});

test.each([
  { name: "non-record root", document: [] },
  { name: "nullable v1 target", document: { schemaVersion: 1, defaultTargetId: null } },
  {
    name: "unknown root field",
    document: {
      schemaVersion: 2,
      defaultTargetId: null,
      modelPolicy: emptyTestModelPolicy(),
      unknown: true,
    },
  },
  {
    name: "unknown model-policy field",
    document: {
      schemaVersion: 2,
      defaultTargetId: null,
      modelPolicy: { ...emptyTestModelPolicy(), unknown: 1 },
    },
  },
  {
    name: "non-positive token value",
    document: {
      schemaVersion: 2,
      defaultTargetId: null,
      modelPolicy: { ...emptyTestModelPolicy(), contextWindowTokens: 0 },
    },
  },
  {
    name: "unsafe token integer",
    document: {
      schemaVersion: 2,
      defaultTargetId: null,
      modelPolicy: { ...emptyTestModelPolicy(), maximumOutputTokens: Number.MAX_SAFE_INTEGER + 1 },
    },
  },
  {
    name: "fractional token value",
    document: {
      schemaVersion: 2,
      defaultTargetId: null,
      modelPolicy: { ...emptyTestModelPolicy(), maximumOutputTokens: 1.5 },
    },
  },
  {
    name: "unknown schema version",
    document: {
      schemaVersion: 3,
      defaultTargetId: null,
      modelPolicy: emptyTestModelPolicy(),
    },
  },
  {
    name: "overlong target ID",
    document: {
      schemaVersion: 2,
      defaultTargetId: "x".repeat(257),
      modelPolicy: emptyTestModelPolicy(),
    },
  },
])("strict user configuration rejects a $name", async ({ document }) => {
  const configuration = createInMemoryUserConfiguration(`${JSON.stringify(document)}\n`);
  await expect(configuration.preferences.load()).resolves.toMatchObject({
    diagnostic: { code: "target_configuration_invalid" },
  });
});

test("a failed reload keeps the last valid in-memory snapshot while failing closed", async () => {
  const valid = {
    schemaVersion: 2,
    defaultTargetId: targetIdentity.targetId,
    modelPolicy: {
      contextWindowTokens: 500_000,
      maximumOutputTokens: 24_000,
      automaticCompactionWindowTokens: 400_000,
    },
  };
  const configuration = createInMemoryUserConfiguration(`${JSON.stringify(valid)}\n`);

  await expect(configuration.preferences.load()).resolves.toMatchObject({
    defaultTargetId: targetIdentity.targetId,
    modelPolicy: valid.modelPolicy,
    diagnostic: null,
  });
  configuration.replace('{"schemaVersion":2,"defaultTargetId":null}\n');

  await expect(configuration.preferences.load()).resolves.toEqual({
    defaultTargetId: targetIdentity.targetId,
    modelPolicy: valid.modelPolicy,
    diagnostic: {
      code: "target_configuration_invalid",
      message: "The saved default target configuration is invalid.",
    },
  });
  await expect(configuration.preferences.resolveContextProfile(officialProfile)).rejects.toThrow(
    "The saved default target configuration is invalid.",
  );
});

function emptyTestModelPolicy() {
  return {
    contextWindowTokens: null,
    maximumOutputTokens: null,
    automaticCompactionWindowTokens: null,
  };
}

test("user output policy also tightens the code-owned compaction summary output cap", async () => {
  const configuration = createInMemoryUserConfiguration(
    `${JSON.stringify({
      schemaVersion: 2,
      defaultTargetId: null,
      modelPolicy: {
        contextWindowTokens: null,
        maximumOutputTokens: 24_000,
        automaticCompactionWindowTokens: null,
      },
    })}\n`,
  );
  const profile: ContextProfile = {
    ...officialProfile,
    version: 2,
    ordinaryOutputReserveTokens: 1_000,
    compactionSummaryMaximumOutputTokens: 30_000,
  };

  await expect(configuration.preferences.resolveContextProfile(profile)).resolves.toEqual({
    ...profile,
    maximumOutputTokens: 24_000,
    compactionSummaryMaximumOutputTokens: 24_000,
  });
});

test("a v2 user output limit tightens the model request for a new session", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-user-configuration-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { mode: 0o700 });
  const configuration = createInMemoryUserConfiguration(
    `${JSON.stringify({
      schemaVersion: 2,
      defaultTargetId: null,
      modelPolicy: {
        contextWindowTokens: null,
        maximumOutputTokens: 24_000,
        automaticCompactionWindowTokens: null,
      },
    })}\n`,
  );
  const { preferences } = configuration;
  let observedMaximumOutputTokens: number | undefined;
  const model = new FakeModelDriver((request) => {
    observedMaximumOutputTokens = request.maximumOutputTokens;
    return [
      { type: "text_delta", text: "Configured answer." },
      { type: "usage", inputTokens: 10, outputTokens: 5 },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile: officialProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: officialProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets,
    preferences,
    workspaceRoot,
  });

  try {
    await lifecycle.admit({
      targetIdentity,
      input: { text: "Use my configured context limits." },
    });

    expect(observedMaximumOutputTokens).toBe(24_000);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("new-session preview exposes the same hand-worked effective profile as admission", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-user-configuration-preview-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { mode: 0o700 });
  const configuration = createInMemoryUserConfiguration(
    `${JSON.stringify({
      schemaVersion: 2,
      defaultTargetId: null,
      modelPolicy: {
        contextWindowTokens: 500_000,
        maximumOutputTokens: 24_000,
        automaticCompactionWindowTokens: 400_000,
      },
    })}\n`,
  );
  const { preferences } = configuration;
  const modelTargets: ModelTargets = {
    async resolve() {
      throw new Error("Preview does not resolve a model driver.");
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: officialProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, preferences, workspaceRoot });

  try {
    await expect(lifecycle.previewNewSession({ targetIdentity })).resolves.toMatchObject({
      targetIdentity,
      contextProfile: {
        ...officialProfile,
        contextWindowTokens: 500_000,
        maximumOutputTokens: 24_000,
        compactAtTokens: 400_000,
      },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Presentation exposes saved policy plus official and effective values with their sources", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-user-configuration-presentation-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { mode: 0o700 });
  const modelPolicy = {
    contextWindowTokens: 500_000,
    maximumOutputTokens: 24_000,
    automaticCompactionWindowTokens: null,
  };
  const configuration = createInMemoryUserConfiguration(
    `${JSON.stringify({ schemaVersion: 2, defaultTargetId: null, modelPolicy })}\n`,
  );
  const { preferences } = configuration;
  const modelTargets: ModelTargets = {
    async resolve() {
      throw new Error("Configuration display does not resolve a model driver.");
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: officialProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, preferences, workspaceRoot });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      openProject: true,
      preferences,
      projectLabel: "workspace",
      workspaceRoot,
    });

    expect(presentation.getState().authoritative.targets).toMatchObject({
      configuration: { modelPolicy },
      items: [
        {
          targetId: targetIdentity.targetId,
          context: {
            official: officialProfile,
            effective: {
              ...officialProfile,
              contextWindowTokens: 500_000,
              maximumOutputTokens: 24_000,
              compactAtTokens: 450_000,
            },
            source: {
              contextWindowTokens: "user",
              maximumOutputTokens: "user",
              compactAtTokens: "user",
            },
          },
        },
      ],
    });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Presentation exposes and clears a valid saved default that is absent from the target catalog", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-unavailable-default-configuration-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { mode: 0o700 });
  const missingTargetId = "removed-target.direct";
  const configuration = createInMemoryUserConfiguration(
    `${JSON.stringify({
      schemaVersion: 2,
      defaultTargetId: missingTargetId,
      modelPolicy: emptyTestModelPolicy(),
    })}\n`,
  );
  const modelTargets: ModelTargets = {
    async resolve() {
      throw new Error("Unavailable default projection does not resolve a model driver.");
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: officialProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets,
    preferences: configuration.preferences,
    workspaceRoot,
  });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      openProject: true,
      preferences: configuration.preferences,
      projectLabel: "workspace",
      workspaceRoot,
    });

    expect(presentation.getState().authoritative.targets).toMatchObject({
      defaultTargetId: missingTargetId,
      diagnostic: {
        code: "target_configuration_invalid",
        message: "The saved default target is not in the current target catalog.",
      },
    });
    await expect(
      presentation.dispatch({ type: "set_default_target", targetId: null }),
    ).resolves.toMatchObject({ status: "admitted" });
    expect(presentation.getState().authoritative.targets).toMatchObject({
      defaultTargetId: null,
      diagnostic: null,
    });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Presentation mutates one model-policy field and republishes its effective value", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-user-configuration-command-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { mode: 0o700 });
  const configuration = createInMemoryUserConfiguration(
    `${JSON.stringify({
      schemaVersion: 2,
      defaultTargetId: targetIdentity.targetId,
      modelPolicy: {
        contextWindowTokens: null,
        maximumOutputTokens: null,
        automaticCompactionWindowTokens: null,
      },
    })}\n`,
  );
  const { preferences } = configuration;
  const modelTargets: ModelTargets = {
    async resolve() {
      throw new Error("Configuration mutation does not resolve a model driver.");
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: officialProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, preferences, workspaceRoot });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      openProject: true,
      preferences,
      projectLabel: "workspace",
      workspaceRoot,
    });
    const command = {
      type: "set_model_policy",
      field: "maximumOutputTokens",
      value: 12_000,
    } as const;

    await expect(presentation.dispatch(command)).resolves.toMatchObject({ status: "admitted" });
    expect(presentation.getState().authoritative.targets).toMatchObject({
      configuration: { modelPolicy: { maximumOutputTokens: 12_000 } },
      items: [
        {
          targetId: targetIdentity.targetId,
          context: {
            effective: { maximumOutputTokens: 12_000 },
            source: { maximumOutputTokens: "user" },
            diagnostic: null,
          },
        },
      ],
    });
    expect(configuration.read()).toBe(
      `${JSON.stringify({
        schemaVersion: 2,
        defaultTargetId: targetIdentity.targetId,
        modelPolicy: {
          contextWindowTokens: null,
          maximumOutputTokens: 12_000,
          automaticCompactionWindowTokens: null,
        },
      })}\n`,
    );

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Presentation rejects user-configuration mutation while a model run is active", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-busy-user-configuration-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { mode: 0o700 });
  const configuration = createInMemoryUserConfiguration();
  const turnStarted = Promise.withResolvers<void>();
  const releaseTurn = Promise.withResolvers<void>();
  const model = {
    async *stream() {
      turnStarted.resolve();
      await releaseTurn.promise;
      yield {
        type: "text_delta",
        text: "Settled after configuration remained unchanged.",
      } as const;
      yield { type: "finish", reason: "stop" } as const;
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile: officialProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: officialProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets,
    preferences: configuration.preferences,
    workspaceRoot,
  });
  const presentation = await createPresentationSession({
    lifecycle,
    modelTargets,
    openProject: true,
    preferences: configuration.preferences,
    projectLabel: "workspace",
    workspaceRoot,
  });

  try {
    await expect(
      presentation.dispatch({ type: "create_session", targetId: targetIdentity.targetId }),
    ).resolves.toMatchObject({ status: "admitted" });
    await expect(
      presentation.dispatch({
        type: "submit_draft_prompt",
        text: "Keep configuration immutable during this run.",
        skills: [],
        thinkingSelection: null,
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    await turnStarted.promise;

    await expect(
      presentation.dispatch({
        type: "set_model_policy",
        field: "maximumOutputTokens",
        value: 12_000,
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "conflict",
      message: "User configuration can be changed only while the session is idle.",
    });
    expect(configuration.read()).toBeNull();
  } finally {
    releaseTurn.resolve();
    await presentation.close();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a v2 user context limit caps new-session output below the effective window", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-user-context-configuration-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { mode: 0o700 });
  const configuration = createInMemoryUserConfiguration(
    `${JSON.stringify({
      schemaVersion: 2,
      defaultTargetId: null,
      modelPolicy: {
        contextWindowTokens: 250_000,
        maximumOutputTokens: null,
        automaticCompactionWindowTokens: null,
      },
    })}\n`,
  );
  const { preferences } = configuration;
  const wideOutputProfile: ContextProfile = {
    ...officialProfile,
    maximumOutputTokens: 300_000,
  };
  let observedMaximumOutputTokens: number | undefined;
  const model = new FakeModelDriver((request) => {
    observedMaximumOutputTokens = request.maximumOutputTokens;
    return [
      { type: "text_delta", text: "Context-limited answer." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile: wideOutputProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: wideOutputProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, preferences, workspaceRoot });

  try {
    await lifecycle.admit({
      targetIdentity,
      input: { text: "Use my configured context window." },
    });

    expect(observedMaximumOutputTokens).toBe(249_999);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("an invalid derived profile fails typed before model dispatch or session allocation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-invalid-user-context-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { mode: 0o700 });
  const configuration = createInMemoryUserConfiguration(
    `${JSON.stringify({
      schemaVersion: 2,
      defaultTargetId: null,
      modelPolicy: {
        contextWindowTokens: 200_000,
        maximumOutputTokens: null,
        automaticCompactionWindowTokens: null,
      },
    })}\n`,
  );
  const { preferences } = configuration;
  let modelCalls = 0;
  const model = new FakeModelDriver(() => {
    modelCalls += 1;
    return [{ type: "finish", reason: "stop" }];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile: officialProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: officialProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, preferences, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Reject an impossible effective profile." },
      }),
    ).rejects.toMatchObject({
      code: "session_user_configuration_invalid",
      message: "The user model configuration does not produce a supported context profile.",
    });
    expect({ modelCalls, sessionIds: await harness.sessions.listSessionIds() }).toEqual({
      modelCalls: 0,
      sessionIds: [],
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a widened persisted genesis v2 profile is rejected before model or effect dispatch", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-widened-historical-profile-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { mode: 0o700 });
  let modelCalls = 0;
  const model = new FakeModelDriver(() => {
    modelCalls += 1;
    return [{ type: "finish", reason: "stop" }];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile: officialProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: officialProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, workspaceRoot });
  const invalidSessionId = "10000000-0000-4000-8000-000000000010";

  try {
    const seed = await lifecycle.create({ targetIdentity });
    const seedStore = await harness.sessions.open(seed.sessionId);
    const seedGenesis = (await seedStore?.read())?.[0];
    if (seedGenesis?.schemaVersion !== 3 || seedGenesis.record.type !== "session_genesis") {
      throw new Error("The caller-visible lifecycle seed must contain current genesis truth.");
    }
    const invalidStore = await harness.sessions.create(invalidSessionId);
    await invalidStore.append({
      schemaVersion: 3,
      sequence: 1,
      record: {
        type: "session_genesis",
        recordVersion: 2,
        sessionId: invalidSessionId,
        projectId: seedGenesis.record.projectId,
        targetIdentity,
        contextProfile: { ...officialProfile, maximumOutputTokens: 40_000 },
      },
    });

    await expect(
      lifecycle.continue({
        sessionId: invalidSessionId,
        input: { text: "Never dispatch this invalid historical profile." },
      }),
    ).rejects.toMatchObject({ code: "session_model_target_incompatible" });
    expect(modelCalls).toBe(0);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("an uncompacted session resumes with its persisted effective profile after policy changes", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-historical-user-profile-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { mode: 0o700 });
  const configuration = createInMemoryUserConfiguration();
  const writeOutputLimit = (maximumOutputTokens: number) =>
    configuration.replace(
      `${JSON.stringify({
        schemaVersion: 2,
        defaultTargetId: null,
        modelPolicy: {
          contextWindowTokens: null,
          maximumOutputTokens,
          automaticCompactionWindowTokens: null,
        },
      })}\n`,
    );
  await writeOutputLimit(24_000);
  const { preferences } = configuration;
  const observedMaximumOutputTokens: number[] = [];
  const model = new FakeModelDriver((request) => {
    observedMaximumOutputTokens.push(request.maximumOutputTokens);
    return [
      { type: "text_delta", text: "Historical profile answer." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile: officialProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: officialProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  let lifecycle = harness.createLifecycle({ modelTargets, preferences, workspaceRoot });

  try {
    const admitted = await lifecycle.admit({
      targetIdentity,
      input: { text: "Create uncompacted historical truth." },
    });
    await lifecycle.close();
    await writeOutputLimit(12_000);
    lifecycle = harness.createLifecycle({ modelTargets, preferences, workspaceRoot });

    await lifecycle.continue({
      sessionId: admitted.snapshot.sessionId,
      input: { text: "Continue with the original effective profile." },
    });

    expect(observedMaximumOutputTokens).toEqual([24_000, 24_000]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a legacy uncompacted session uses its official profile and never the current user policy", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-legacy-user-profile-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { mode: 0o700 });
  const configuration = createInMemoryUserConfiguration(
    `${JSON.stringify({
      schemaVersion: 2,
      defaultTargetId: null,
      modelPolicy: {
        contextWindowTokens: null,
        maximumOutputTokens: 12_000,
        automaticCompactionWindowTokens: null,
      },
    })}\n`,
  );
  const { preferences } = configuration;
  let observedMaximumOutputTokens: number | undefined;
  const model = new FakeModelDriver((request) => {
    observedMaximumOutputTokens = request.maximumOutputTokens;
    return [
      { type: "text_delta", text: "Legacy official profile answer." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile: officialProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: officialProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, preferences, workspaceRoot });

  try {
    const legacy = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: legacy.sessionId,
      input: { text: "Continue legacy history without applying current policy." },
    });

    expect(observedMaximumOutputTokens).toBe(officialProfile.maximumOutputTokens);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a legacy compacted session reuses the selected-prefix profile instead of current policy or code defaults", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-legacy-compacted-profile-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { mode: 0o700 });
  await writeFile(join(workspaceRoot, "context.txt"), "legacy context ".repeat(220), "utf8");
  const configuration = createInMemoryUserConfiguration(
    `${JSON.stringify({
      schemaVersion: 2,
      defaultTargetId: null,
      modelPolicy: {
        contextWindowTokens: null,
        maximumOutputTokens: 50,
        automaticCompactionWindowTokens: null,
      },
    })}\n`,
  );
  const { preferences } = configuration;
  const historicalOfficialProfile: ContextProfile = {
    version: 1,
    contextWindowTokens: 20_000,
    maximumOutputTokens: 100,
    compactAtTokens: 900,
    postCompactTargetTokens: 700,
    retainedTargetTokens: 100,
    estimatorVersion: 1,
  };
  const currentOfficialProfile: ContextProfile = {
    ...historicalOfficialProfile,
    contextWindowTokens: 30_000,
    maximumOutputTokens: 200,
    compactAtTokens: 1_500,
  };
  const summary = JSON.stringify({
    schemaVersion: 1,
    objective: "Retain the legacy compaction profile.",
    constraints: [],
    progress: [],
    unresolvedQuestions: [],
    failures: [],
    remainingVerification: [],
    nextSafeAction: "Continue with the historical profile.",
  });
  const observedOrdinaryMaximumOutputTokens: number[] = [];
  let ordinaryCall = 0;
  const model = new FakeModelDriver((request) => {
    if (request.tools.length === 0) {
      return [
        { type: "text_delta", text: summary },
        { type: "usage", inputTokens: 300, outputTokens: 20 },
        { type: "finish", reason: "stop" },
      ];
    }
    ordinaryCall += 1;
    observedOrdinaryMaximumOutputTokens.push(request.maximumOutputTokens);
    if (ordinaryCall === 1) {
      return [
        { type: "usage", inputTokens: 30, outputTokens: 10 },
        { type: "tool_call_start", id: "read-legacy-context", name: "read_file" },
        {
          type: "tool_call_delta",
          id: "read-legacy-context",
          json: '{"path":"context.txt"}',
        },
        { type: "tool_call_end", id: "read-legacy-context" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    return [
      { type: "text_delta", text: "Legacy compacted profile answer." },
      { type: "usage", inputTokens: 100, outputTokens: 5 },
      { type: "finish", reason: "stop" },
    ];
  });
  let currentProfile = historicalOfficialProfile;
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile: currentProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: currentProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycleOptions = {
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    preferences,
    tools: createReadToolRegistry({ workspaceRoot }),
    workspaceRoot,
  };
  let lifecycle = harness.createLifecycle(lifecycleOptions);

  try {
    const legacy = await lifecycle.create({ targetIdentity });
    await expect(
      lifecycle.continue({
        sessionId: legacy.sessionId,
        input: { text: "Read context.txt and preserve the legacy checkpoint." },
      }),
    ).resolves.toMatchObject({ result: { status: "completed" } });
    await lifecycle.close();
    currentProfile = currentOfficialProfile;
    lifecycle = harness.createLifecycle(lifecycleOptions);

    await lifecycle.continue({
      sessionId: legacy.sessionId,
      input: { text: "Use the selected-prefix compaction profile." },
    });

    expect(observedOrdinaryMaximumOutputTokens).toEqual([100, 100, 100]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a same-target branch inherits the selected prefix effective profile", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-branch-user-profile-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { mode: 0o700 });
  const configuration = createInMemoryUserConfiguration();
  const writeOutputLimit = (maximumOutputTokens: number) =>
    configuration.replace(
      `${JSON.stringify({
        schemaVersion: 2,
        defaultTargetId: null,
        modelPolicy: {
          contextWindowTokens: null,
          maximumOutputTokens,
          automaticCompactionWindowTokens: null,
        },
      })}\n`,
    );
  await writeOutputLimit(24_000);
  const { preferences } = configuration;
  const observedMaximumOutputTokens: number[] = [];
  const model = new FakeModelDriver((request) => {
    observedMaximumOutputTokens.push(request.maximumOutputTokens);
    return [
      { type: "text_delta", text: "Branch profile answer." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile: officialProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: officialProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, preferences, workspaceRoot });

  try {
    const admitted = await lifecycle.admit({
      targetIdentity,
      input: { text: "Create branchable historical truth." },
    });
    await writeOutputLimit(12_000);
    const child = await lifecycle.branch({
      parentSessionId: admitted.snapshot.sessionId,
      atSequence: admitted.snapshot.lastSequence,
      targetId: targetIdentity.targetId,
    });

    await lifecycle.continue({
      sessionId: child.sessionId,
      input: { text: "Continue the branch with inherited limits." },
    });

    expect(observedMaximumOutputTokens).toEqual([24_000, 24_000]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a target-changing branch persists the current user policy for the new target", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-retarget-branch-user-profile-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { mode: 0o700 });
  const configuration = createInMemoryUserConfiguration();
  const writeOutputLimit = (maximumOutputTokens: number) =>
    configuration.replace(
      `${JSON.stringify({
        schemaVersion: 2,
        defaultTargetId: null,
        modelPolicy: {
          contextWindowTokens: null,
          maximumOutputTokens,
          automaticCompactionWindowTokens: null,
        },
      })}\n`,
    );
  await writeOutputLimit(24_000);
  const { preferences } = configuration;
  const observedMaximumOutputTokens: number[] = [];
  const model = new FakeModelDriver((request) => {
    observedMaximumOutputTokens.push(request.maximumOutputTokens);
    return [
      { type: "text_delta", text: "Retargeted branch answer." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve(input) {
      const identity =
        input.targetId === alternateTargetIdentity.targetId
          ? alternateTargetIdentity
          : targetIdentity;
      return { identity, driver: model, contextProfile: officialProfile };
    },
    async snapshot() {
      return {
        targets: [targetIdentity, alternateTargetIdentity].map((identity) => ({
          identity,
          readiness: { status: "available" as const, credentialSource: "test adapter" },
          contextProfile: officialProfile,
        })),
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, preferences, workspaceRoot });

  try {
    const admitted = await lifecycle.admit({
      targetIdentity,
      input: { text: "Create retargetable historical truth." },
    });
    await writeOutputLimit(12_000);
    const child = await lifecycle.branch({
      parentSessionId: admitted.snapshot.sessionId,
      atSequence: admitted.snapshot.lastSequence,
      targetId: alternateTargetIdentity.targetId,
    });

    await lifecycle.continue({
      sessionId: child.sessionId,
      input: { text: "Continue the new target with current limits." },
    });

    expect(observedMaximumOutputTokens).toEqual([24_000, 12_000]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a v2 automatic compaction limit is persisted as an absolute effective threshold", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-user-compaction-configuration-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { mode: 0o700 });
  const configuration = createInMemoryUserConfiguration(
    `${JSON.stringify({
      schemaVersion: 2,
      defaultTargetId: null,
      modelPolicy: {
        contextWindowTokens: null,
        maximumOutputTokens: null,
        automaticCompactionWindowTokens: 450,
      },
    })}\n`,
  );
  const { preferences } = configuration;
  const compactingProfile: ContextProfile = {
    version: 1,
    contextWindowTokens: 20_000,
    maximumOutputTokens: 100,
    compactAtTokens: 15_000,
    postCompactTargetTokens: 400,
    retainedTargetTokens: 100,
    estimatorVersion: 1,
  };
  const summary = JSON.stringify({
    schemaVersion: 1,
    objective: "Preserve the configured compaction threshold.",
    constraints: [],
    progress: [],
    unresolvedQuestions: [],
    failures: [],
    remainingVerification: [],
    nextSafeAction: "Complete the ordinary request.",
  });
  const model = new FakeModelDriver((request) =>
    request.tools.length === 0
      ? [
          { type: "text_delta", text: summary },
          { type: "usage", inputTokens: 300, outputTokens: 20 },
          { type: "finish", reason: "stop" },
        ]
      : [
          { type: "text_delta", text: "Compaction limit observed." },
          { type: "usage", inputTokens: 100, outputTokens: 5 },
          { type: "finish", reason: "stop" },
        ],
  );
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile: compactingProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: compactingProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, preferences, workspaceRoot });

  try {
    const admitted = await lifecycle.admit({
      targetIdentity,
      input: { text: "Preserve the older objective. ".repeat(120) },
    });
    const persisted = await lifecycle.inspect({ sessionId: admitted.snapshot.sessionId });

    expect(persisted.schemaVersion === 3 ? persisted.context?.profile : undefined).toEqual({
      ...compactingProfile,
      compactAtTokens: 450,
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});
