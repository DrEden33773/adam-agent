import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ContextProfile,
  createExtensionHost,
  createPermissionPolicy,
  createPresentationSession,
  createReadToolRegistry,
  type ModelTargetIdentity,
  type ModelTargets,
  type PresentationPreferences,
  type RuntimeEvent,
} from "@adam-agent/agent";
import {
  createPresentationPreferencesWithStorageForTesting,
  createWorkspaceTrustWithStorageForTesting,
  mcpTransportFactory,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import {
  createInMemorySessionLifecycleHarness,
  createScriptedMcpTransportFactory,
  FakeModelDriver,
} from "./index.js";

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

function createInMemoryWorkspaceTrustConfiguration(
  workspaceRoot: string,
  initialText: string | null = null,
): {
  readonly controller: ReturnType<typeof createWorkspaceTrustWithStorageForTesting>;
  read(): string | null;
  replace(text: string | null): void;
  failWrites(): void;
} {
  let text = initialText;
  let writesFail = false;
  const controller = createWorkspaceTrustWithStorageForTesting({
    workspaceRoot,
    storage: {
      async read() {
        return text === null ? { status: "missing" } : { status: "available", text };
      },
      async write(nextText) {
        if (writesFail) {
          throw new Error("Injected workspace trust write failure.");
        }
        text = nextText;
      },
    },
  });
  return {
    controller,
    read: () => text,
    replace(nextText) {
      text = nextText;
    },
    failWrites() {
      writesFail = true;
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

test("Presentation exposes workspace trust and rejects a stale trust command", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-workspace-trust-presentation-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let trustDocument: string | null = null;
  const workspaceTrust = createWorkspaceTrustWithStorageForTesting({
    workspaceRoot,
    storage: {
      async read() {
        return trustDocument === null
          ? { status: "missing" as const }
          : { status: "available" as const, text: trustDocument };
      },
      async write(text) {
        trustDocument = text;
      },
    },
  });
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ workspaceRoot, workspaceTrust });
  const presentation = await createPresentationSession({
    lifecycle,
    openProject: true,
    projectLabel: "ignored-noncanonical-label",
    workspaceRoot,
  });

  try {
    const project = presentation.getState().authoritative.project;
    expect(project).toMatchObject({
      label: "workspace",
      workspaceTrust: { status: "untrusted", diagnostic: null },
    });
    await expect(
      presentation.dispatch({
        type: "set_workspace_trust",
        projectId: `sha256:${"0".repeat(64)}`,
        trusted: true,
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "stale_interaction",
      message: "The workspace trust command targets a stale project identity.",
    });
    expect(trustDocument).toBeNull();

    await expect(
      presentation.dispatch({
        type: "set_workspace_trust",
        projectId: project.id,
        trusted: true,
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    expect(presentation.getState().authoritative.project).toEqual({
      id: project.id,
      label: "workspace",
      workspaceTrust: { status: "trusted", diagnostic: null },
    });
  } finally {
    await presentation.close();
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
    const projectId = presentation.getState().authoritative.project.id;
    await expect(
      presentation.dispatch({ type: "set_workspace_trust", projectId, trusted: false }),
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

const boundedWorkspaceTrustIds = Array.from(
  { length: 1_025 },
  (_, index) => `sha256:${index.toString(16).padStart(64, "0")}`,
);

test.each([
  { caseName: "empty", text: "" },
  { caseName: "malformed JSON", text: "{" },
  {
    caseName: "duplicate object key",
    text: '{"schemaVersion":1,"schemaVersion":1,"trustedProjectIds":[]}',
  },
  {
    caseName: "unknown field",
    text: JSON.stringify({ schemaVersion: 1, trustedProjectIds: [], wildcard: true }),
  },
  {
    caseName: "wrong version",
    text: JSON.stringify({ schemaVersion: 2, trustedProjectIds: [] }),
  },
  {
    caseName: "uppercase digest",
    text: JSON.stringify({ schemaVersion: 1, trustedProjectIds: [`sha256:${"A".repeat(64)}`] }),
  },
  {
    caseName: "duplicate digest",
    text: JSON.stringify({
      schemaVersion: 1,
      trustedProjectIds: [boundedWorkspaceTrustIds[0], boundedWorkspaceTrustIds[0]],
    }),
  },
  {
    caseName: "unsorted digests",
    text: JSON.stringify({
      schemaVersion: 1,
      trustedProjectIds: [boundedWorkspaceTrustIds[1], boundedWorkspaceTrustIds[0]],
    }),
  },
  {
    caseName: "too many digests",
    text: JSON.stringify({ schemaVersion: 1, trustedProjectIds: boundedWorkspaceTrustIds }),
  },
  { caseName: "oversized bytes", text: "x".repeat(128 * 1024 + 1) },
])("workspace trust rejects a strict $caseName document", async ({ text }) => {
  const configuration = createInMemoryWorkspaceTrustConfiguration(process.cwd(), text);

  await expect(configuration.controller.load()).resolves.toMatchObject({
    status: "untrusted",
    diagnostic: { code: "workspace_trust_invalid" },
  });
});

test("workspace trust persists an exact sorted unique bounded document", async () => {
  const configuration = createInMemoryWorkspaceTrustConfiguration(
    process.cwd(),
    `${JSON.stringify({
      schemaVersion: 1,
      trustedProjectIds: [boundedWorkspaceTrustIds[0], boundedWorkspaceTrustIds[1024]],
    })}\n`,
  );
  const current = await configuration.controller.load();
  if (current.projectId === null) {
    throw new Error("The fixture requires one canonical project identity.");
  }

  await configuration.controller.setTrusted({ projectId: current.projectId, trusted: true });
  const document = JSON.parse(configuration.read() ?? "null") as {
    readonly schemaVersion: number;
    readonly trustedProjectIds: readonly string[];
  };
  expect(document).toEqual({
    schemaVersion: 1,
    trustedProjectIds: [...document.trustedProjectIds].sort(),
  });
  expect(new Set(document.trustedProjectIds).size).toBe(3);
});

test("workspace trust refuses to exceed 1024 project identities", async () => {
  const configuration = createInMemoryWorkspaceTrustConfiguration(process.cwd());
  const current = await configuration.controller.load();
  if (current.projectId === null) {
    throw new Error("The fixture requires one canonical project identity.");
  }
  const full = boundedWorkspaceTrustIds.filter((id) => id !== current.projectId).slice(0, 1_024);
  configuration.replace(`${JSON.stringify({ schemaVersion: 1, trustedProjectIds: full })}\n`);

  await expect(
    configuration.controller.setTrusted({ projectId: current.projectId, trusted: true }),
  ).rejects.toThrow("workspace trust configuration is full");
  expect(JSON.parse(configuration.read() ?? "null")).toEqual({
    schemaVersion: 1,
    trustedProjectIds: full,
  });
});

test("a failed workspace trust write publishes no current-process authority", async () => {
  const preferences = createInMemoryUserConfiguration(
    `${JSON.stringify({ schemaVersion: 1, defaultTargetId: targetIdentity.targetId })}\n`,
  );
  const configuration = createInMemoryWorkspaceTrustConfiguration(process.cwd());
  const current = await configuration.controller.load();
  if (current.projectId === null) {
    throw new Error("The fixture requires one canonical project identity.");
  }
  configuration.failWrites();

  await expect(
    configuration.controller.setTrusted({ projectId: current.projectId, trusted: true }),
  ).rejects.toThrow("Injected workspace trust write failure");
  await expect(configuration.controller.load()).resolves.toMatchObject({
    status: "untrusted",
    diagnostic: null,
  });
  expect(await preferences.preferences.load()).toMatchObject({
    defaultTargetId: targetIdentity.targetId,
    diagnostic: null,
  });
});

test("an unreadable workspace trust document fails closed", async () => {
  const controller = createWorkspaceTrustWithStorageForTesting({
    workspaceRoot: process.cwd(),
    storage: {
      async read() {
        throw new Error("Injected workspace trust read failure.");
      },
      async write() {
        throw new Error("The unavailable document must not be repaired implicitly.");
      },
    },
  });

  await expect(controller.load()).resolves.toMatchObject({
    status: "untrusted",
    diagnostic: { code: "workspace_trust_unsafe" },
  });
});

test("workspace trust reports unavailable when canonical identity cannot be resolved", async () => {
  const controller = createWorkspaceTrustWithStorageForTesting({
    workspaceRoot: join(tmpdir(), `missing-workspace-${randomUUID()}`),
    storage: {
      async read() {
        return { status: "missing" };
      },
      async write() {
        throw new Error("An unavailable identity must not be persisted.");
      },
    },
  });

  await expect(controller.load()).resolves.toMatchObject({
    projectId: null,
    status: "unavailable",
    diagnostic: { code: "workspace_trust_unavailable" },
  });
});

test("workspace trust keys aliases to one real canonical project identity", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-workspace-trust-canonical-"));
  const canonicalRoot = join(testRoot, "canonical-project");
  const aliasRoot = join(testRoot, "project-alias");
  await mkdir(canonicalRoot);
  await symlink(canonicalRoot, aliasRoot, "dir");
  const canonical = createInMemoryWorkspaceTrustConfiguration(canonicalRoot);
  const alias = createInMemoryWorkspaceTrustConfiguration(aliasRoot);

  try {
    const [canonicalSnapshot, aliasSnapshot] = await Promise.all([
      canonical.controller.load(),
      alias.controller.load(),
    ]);
    expect(aliasSnapshot).toEqual({
      projectId: canonicalSnapshot.projectId,
      projectLabel: "canonical-project",
      status: "untrusted",
      diagnostic: null,
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("workspace revoke and re-trust remain explicit across runtime restart", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-workspace-trust-restart-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "AGENTS.md"), "RETRUSTED_PROJECT\n", "utf8");
  const configuration = createInMemoryWorkspaceTrustConfiguration(workspaceRoot);
  const harness = createInMemorySessionLifecycleHarness();
  let lifecycle = harness.createLifecycle({
    workspaceRoot,
    workspaceTrust: configuration.controller,
  });

  try {
    const initial = await lifecycle.inspectWorkspaceTrust();
    if (initial.projectId === null) {
      throw new Error("The fixture requires one canonical project identity.");
    }
    await lifecycle.configureWorkspaceTrust({ type: "grant", projectId: initial.projectId });
    await lifecycle.configureWorkspaceTrust({ type: "revoke", projectId: initial.projectId });
    await lifecycle.close();
    lifecycle = harness.createLifecycle({
      workspaceRoot,
      workspaceTrust: configuration.controller,
    });
    await expect(lifecycle.inspectWorkspaceTrust()).resolves.toMatchObject({
      projectId: initial.projectId,
      status: "untrusted",
    });
    await lifecycle.configureWorkspaceTrust({ type: "grant", projectId: initial.projectId });
    const created = await lifecycle.create({ targetIdentity });
    expect(created.promptContext?.repository.sources).toMatchObject([
      { selectedName: "AGENTS.md" },
    ]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("historical B8 source confirmation never migrates into workspace trust", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-workspace-trust-no-migration-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: { type: "stdio", command: process.execPath, args: ["--version"], env: {} },
      },
    }),
    "utf8",
  );
  const configuration = createInMemoryWorkspaceTrustConfiguration(workspaceRoot);
  const harness = createInMemorySessionLifecycleHarness();
  let lifecycle = harness.createLifecycle({
    workspaceRoot,
    workspaceTrust: configuration.controller,
  });

  try {
    const initial = await lifecycle.inspectWorkspaceTrust();
    if (initial.projectId === null) {
      throw new Error("The fixture requires one canonical project identity.");
    }
    await lifecycle.configureWorkspaceTrust({ type: "grant", projectId: initial.projectId });
    const created = await lifecycle.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires an MCP configuration snapshot.");
    }
    await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });
    await lifecycle.close();
    configuration.replace(null);
    lifecycle = harness.createLifecycle({
      workspaceRoot,
      workspaceTrust: configuration.controller,
    });

    await expect(lifecycle.inspectWorkspaceTrust()).resolves.toMatchObject({
      status: "untrusted",
      diagnostic: null,
    });
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.not.toHaveProperty(
      "mcp",
    );
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("explicit durable workspace trust gates new project instructions, Skills, and MCP only", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-workspace-trust-admission-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const isolatedHome = join(testRoot, "home");
  const extensionRoot = join(testRoot, "extension");
  const projectSkillRoot = join(workspaceRoot, ".agents", "skills", "project-context");
  const userSkillRoot = join(isolatedHome, ".agents", "skills", "user-context");
  const extensionSkillRoot = join(extensionRoot, "skills", "extension-context");
  // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires indexed ProcessEnv access.
  const previousHome = process.env["HOME"];
  let trustDocument: string | null = null;
  await mkdir(projectSkillRoot, { recursive: true });
  await mkdir(userSkillRoot, { recursive: true });
  await mkdir(extensionSkillRoot, { recursive: true });
  await writeFile(join(workspaceRoot, "AGENTS.md"), "PROJECT_INSTRUCTION\n", "utf8");
  await writeFile(
    join(projectSkillRoot, "SKILL.md"),
    "---\nname: project-context\ndescription: Project-owned context.\n---\nPROJECT_SKILL\n",
    "utf8",
  );
  await writeFile(
    join(userSkillRoot, "SKILL.md"),
    "---\nname: user-context\ndescription: User-owned context.\n---\nUSER_SKILL\n",
    "utf8",
  );
  await writeFile(
    join(extensionSkillRoot, "SKILL.md"),
    "---\nname: extension-context\ndescription: Extension-owned context.\n---\nEXTENSION_SKILL\n",
    "utf8",
  );
  await writeFile(
    join(extensionRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/workspace-trust-extension",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.workspace-trust-extension",
        apiVersion: "^0.3.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(join(extensionRoot, "extension.js"), "export async function activate() {}\n");
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: { type: "stdio", command: process.execPath, args: ["--version"], env: {} },
      },
    }),
    "utf8",
  );
  // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires indexed ProcessEnv access.
  process.env["HOME"] = isolatedHome;
  const workspaceTrust = createWorkspaceTrustWithStorageForTesting({
    workspaceRoot,
    storage: {
      async read() {
        return trustDocument === null
          ? { status: "missing" as const }
          : { status: "available" as const, text: trustDocument };
      },
      async write(text) {
        trustDocument = text;
      },
    },
  });
  const extensionHost = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.workspace-trust-extension",
        grants: [],
        packageName: "@fixture/workspace-trust-extension",
        packageRoot: extensionRoot,
        packageVersion: "1.0.0",
      },
    ],
    projectRoot: workspaceRoot,
    stateRoot,
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      throw new Error("The workspace trust preview does not resolve a model driver.");
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
  let lifecycle = harness.createLifecycle({
    extensionHost,
    modelTargets,
    workspaceRoot,
    workspaceTrust,
  });

  try {
    const before = await lifecycle.previewNewSession({ targetIdentity });
    const beforeTrust = await lifecycle.inspectWorkspaceTrust();
    if (beforeTrust.projectId === null) {
      throw new Error("The fixture requires one canonical project identity.");
    }
    expect({
      trust: beforeTrust,
      skillSources: before.skillContext?.catalog.entries.map(
        (candidate) => candidate.locator.source,
      ),
    }).toEqual({
      trust: {
        projectId: beforeTrust.projectId,
        projectLabel: "workspace",
        status: "untrusted",
        diagnostic: null,
      },
      skillSources: ["extension", "user"],
    });

    await expect(
      lifecycle.configureWorkspaceTrust({
        type: "grant",
        projectId: beforeTrust.projectId,
      }),
    ).resolves.toMatchObject({ status: "updated", snapshot: { status: "trusted" } });
    expect(trustDocument).toBe(
      `${JSON.stringify({ schemaVersion: 1, trustedProjectIds: [beforeTrust.projectId] })}\n`,
    );
    await lifecycle.close();
    lifecycle = harness.createLifecycle({
      extensionHost,
      modelTargets,
      workspaceRoot,
      workspaceTrust,
    });

    const after = await lifecycle.create({ targetIdentity });
    expect({
      trust: await lifecycle.inspectWorkspaceTrust(),
      repositorySources: after.promptContext?.repository.sources.map(
        (source) => source.selectedName,
      ),
      skillSources: after.skillContext?.catalog.entries.map(
        (candidate) => candidate.locator.source,
      ),
      mcp: after.mcp,
    }).toEqual({
      trust: {
        projectId: after.projectId,
        projectLabel: "workspace",
        status: "trusted",
        diagnostic: null,
      },
      repositorySources: ["AGENTS.md"],
      skillSources: ["extension", "project", "user"],
      mcp: {
        schemaVersion: 1,
        status: "workspace_confirmation_required",
        workspaceConfirmed: false,
        source: {
          path: ".mcp.json",
          digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
        servers: [],
        diagnostics: [],
      },
    });
  } finally {
    if (previousHome === undefined) {
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires indexed ProcessEnv access.
      delete process.env["HOME"];
    } else {
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires indexed ProcessEnv access.
      process.env["HOME"] = previousHome;
    }
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("an ordinary prompt in an untrusted workspace fails before project or model dispatch", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-untrusted-prompt-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "AGENTS.md"), "NEVER_LOAD_UNTRUSTED_CONTEXT\n", "utf8");
  let modelCalls = 0;
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: targetIdentity,
        driver: new FakeModelDriver(() => {
          modelCalls += 1;
          return [{ type: "finish", reason: "stop" }];
        }),
        contextProfile: officialProfile,
      };
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
  const workspaceTrust = createWorkspaceTrustWithStorageForTesting({
    workspaceRoot,
    storage: {
      async read() {
        return { status: "missing" };
      },
      async write() {
        throw new Error("The untrusted admission must not mutate workspace trust.");
      },
    },
  });
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, workspaceRoot, workspaceTrust });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Do not dispatch this untrusted request." },
      }),
    ).rejects.toMatchObject({
      code: "session_workspace_untrusted",
      message:
        "This workspace is not trusted. Run adam-agent --trust-workspace in this project, then retry.",
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

test("direct session creation cannot stage a later prompt around the workspace trust gate", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-untrusted-session-create-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const configuration = createInMemoryWorkspaceTrustConfiguration(workspaceRoot);
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    workspaceRoot,
    workspaceTrust: configuration.controller,
  });

  try {
    await expect(lifecycle.create({ targetIdentity })).rejects.toMatchObject({
      code: "session_workspace_untrusted",
    });
    await expect(lifecycle.listProjectSessions({ limit: 10 })).resolves.toMatchObject({
      items: [],
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("revoking workspace trust preserves historical context but blocks mutable project reloads", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-revoked-project-reload-"));
  const workspaceRoot = join(testRoot, "workspace");
  const projectSkillRoot = join(workspaceRoot, ".agents", "skills", "project-context");
  await mkdir(projectSkillRoot, { recursive: true });
  await writeFile(join(workspaceRoot, "AGENTS.md"), "ORIGINAL_PROJECT_INSTRUCTION\n", "utf8");
  await writeFile(
    join(projectSkillRoot, "SKILL.md"),
    "---\nname: project-context\ndescription: Original project Skill.\n---\n",
    "utf8",
  );
  let trustDocument: string | null = null;
  const workspaceTrust = createWorkspaceTrustWithStorageForTesting({
    workspaceRoot,
    storage: {
      async read() {
        return trustDocument === null
          ? { status: "missing" as const }
          : { status: "available" as const, text: trustDocument };
      },
      async write(text) {
        trustDocument = text;
      },
    },
  });
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ workspaceRoot, workspaceTrust });

  try {
    const status = await lifecycle.inspectWorkspaceTrust();
    if (status.projectId === null) {
      throw new Error("The fixture requires one canonical project identity.");
    }
    await lifecycle.configureWorkspaceTrust({ type: "grant", projectId: status.projectId });
    const created = await lifecycle.create({ targetIdentity });
    const originalInstructionDigest = created.promptContext?.repository.sources[0]?.contentDigest;
    await lifecycle.configureWorkspaceTrust({ type: "revoke", projectId: status.projectId });
    await writeFile(join(workspaceRoot, "AGENTS.md"), "CHANGED_PROJECT_INSTRUCTION\n", "utf8");
    await writeFile(
      join(projectSkillRoot, "SKILL.md"),
      "---\nname: project-context\ndescription: Changed project Skill.\n---\n",
      "utf8",
    );

    await expect(
      lifecycle.reloadRepositoryInstructions({ sessionId: created.sessionId }),
    ).rejects.toMatchObject({ code: "session_workspace_untrusted" });
    await expect(lifecycle.reloadSkills({ sessionId: created.sessionId })).rejects.toMatchObject({
      code: "session_workspace_untrusted",
    });
    const historical = await lifecycle.inspect({ sessionId: created.sessionId });
    if (historical.schemaVersion !== 3) {
      throw new Error("The fixture requires a current session snapshot.");
    }
    expect({
      instructionDigest: historical.promptContext?.repository.sources[0]?.contentDigest,
      skillDescription: historical.skillContext?.catalog.entries[0]?.description,
    }).toEqual({
      instructionDigest: originalInstructionDigest,
      skillDescription: "Original project Skill.",
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("revoked historical sessions cannot activate a project Skill from mutable bytes", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-revoked-project-skill-"));
  const workspaceRoot = join(testRoot, "workspace");
  const skillRoot = join(workspaceRoot, ".agents", "skills", "revoked-skill");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: revoked-skill\ndescription: Original project Skill.\n---\nORIGINAL_SKILL_BODY\n",
    "utf8",
  );
  const configuration = createInMemoryWorkspaceTrustConfiguration(workspaceRoot);
  const model = new FakeModelDriver((request) =>
    request.messages.at(-1)?.role === "user"
      ? [
          { type: "tool_call_start", id: "activate-revoked-skill", name: "activate_skill" },
          {
            type: "tool_call_delta",
            id: "activate-revoked-skill",
            json: JSON.stringify({ qualifiedId: "skill:v1:project:.:revoked-skill" }),
          },
          { type: "tool_call_end", id: "activate-revoked-skill" },
          { type: "finish", reason: "tool_calls" },
        ]
      : [
          { type: "text_delta", text: "Revoked project Skill stayed unavailable." },
          { type: "finish", reason: "stop" },
        ],
  );
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
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    workspaceRoot,
    workspaceTrust: configuration.controller,
  });
  const events: RuntimeEvent[] = [];
  lifecycle.subscribe((event) => events.push(event));

  try {
    const status = await lifecycle.inspectWorkspaceTrust();
    if (status.projectId === null) {
      throw new Error("The fixture requires one canonical project identity.");
    }
    await lifecycle.configureWorkspaceTrust({ type: "grant", projectId: status.projectId });
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.configureWorkspaceTrust({ type: "revoke", projectId: status.projectId });
    await writeFile(
      join(skillRoot, "SKILL.md"),
      "---\nname: revoked-skill\ndescription: Changed project Skill.\n---\nCHANGED_SKILL_BODY\n",
      "utf8",
    );

    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Try to activate the historical project Skill." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "Revoked project Skill stayed unavailable." },
      snapshot: { skillContext: { active: [] } },
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_failed",
          callId: "activate-revoked-skill",
          error: expect.objectContaining({ code: "skill_unavailable" }),
        }),
      ]),
    );
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("revoked historical sessions reject an explicit project Skill before model dispatch", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-revoked-explicit-skill-"));
  const workspaceRoot = join(testRoot, "workspace");
  const skillRoot = join(workspaceRoot, ".agents", "skills", "explicit-revoked");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: explicit-revoked\ndescription: Explicit project Skill.\n---\nEXPLICIT_PROJECT_BODY\n",
    "utf8",
  );
  const configuration = createInMemoryWorkspaceTrustConfiguration(workspaceRoot);
  let providerCalls = 0;
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: targetIdentity,
        driver: new FakeModelDriver(() => {
          providerCalls += 1;
          return [{ type: "finish", reason: "stop" }];
        }),
        contextProfile: officialProfile,
      };
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
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    workspaceRoot,
    workspaceTrust: configuration.controller,
  });

  try {
    const status = await lifecycle.inspectWorkspaceTrust();
    if (status.projectId === null) {
      throw new Error("The fixture requires one canonical project identity.");
    }
    await lifecycle.configureWorkspaceTrust({ type: "grant", projectId: status.projectId });
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.configureWorkspaceTrust({ type: "revoke", projectId: status.projectId });

    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: {
          text: "Try the explicit project Skill after revocation.",
          skills: ["skill:v1:project:.:explicit-revoked"],
        },
      }),
    ).resolves.toMatchObject({
      result: { status: "failed", error: { code: "skill_activation_failed" } },
      snapshot: { skillContext: { active: [] } },
    });
    expect(providerCalls).toBe(0);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("revoked historical sessions cannot read a live resource from an active project Skill", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-revoked-skill-resource-"));
  const workspaceRoot = join(testRoot, "workspace");
  const skillRoot = join(workspaceRoot, ".agents", "skills", "resource-revoked");
  await mkdir(join(skillRoot, "references"), { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: resource-revoked\ndescription: Project Skill with a resource.\n---\nRead references/guide.txt.\n",
    "utf8",
  );
  await writeFile(join(skillRoot, "references", "guide.txt"), "PROJECT_RESOURCE_BYTES\n", "utf8");
  const configuration = createInMemoryWorkspaceTrustConfiguration(workspaceRoot);
  const model = new FakeModelDriver((request) => {
    const latest = request.messages.at(-1);
    if (
      latest?.role === "user" &&
      typeof latest.content === "string" &&
      latest.content.includes("Read the active")
    ) {
      return [
        { type: "tool_call_start", id: "read-revoked-resource", name: "read_skill_resource" },
        {
          type: "tool_call_delta",
          id: "read-revoked-resource",
          json: JSON.stringify({
            qualifiedId: "skill:v1:project:.:resource-revoked",
            path: "references/guide.txt",
            offset: 0,
            maxByteCount: 256,
          }),
        },
        { type: "tool_call_end", id: "read-revoked-resource" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    return [
      {
        type: "text_delta",
        text:
          latest?.role === "tool"
            ? "Revoked project resource stayed unavailable."
            : "Project Skill activated while trusted.",
      },
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
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    workspaceRoot,
    workspaceTrust: configuration.controller,
  });
  const events: RuntimeEvent[] = [];
  lifecycle.subscribe((event) => events.push(event));

  try {
    const status = await lifecycle.inspectWorkspaceTrust();
    if (status.projectId === null) {
      throw new Error("The fixture requires one canonical project identity.");
    }
    await lifecycle.configureWorkspaceTrust({ type: "grant", projectId: status.projectId });
    const created = await lifecycle.create({ targetIdentity });
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: {
          text: "Activate the project Skill while trusted.",
          skills: ["skill:v1:project:.:resource-revoked"],
        },
      }),
    ).resolves.toMatchObject({ result: { status: "completed" } });
    await lifecycle.configureWorkspaceTrust({ type: "revoke", projectId: status.projectId });

    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Read the active project Skill resource after revocation." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "Revoked project resource stayed unavailable." },
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_failed",
          callId: "read-revoked-resource",
          error: expect.objectContaining({ code: "skill_resource_unavailable" }),
        }),
      ]),
    );
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("revoked historical sessions cannot activate descendant project context", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-revoked-descendant-context-"));
  const workspaceRoot = join(testRoot, "workspace");
  const nestedRoot = join(workspaceRoot, "nested");
  const nestedSkillRoot = join(nestedRoot, ".agents", "skills", "nested-context");
  await mkdir(nestedSkillRoot, { recursive: true });
  await writeFile(join(nestedRoot, "AGENTS.md"), "NESTED_PROJECT_INSTRUCTION\n", "utf8");
  await writeFile(join(nestedRoot, "target.txt"), "nested target\n", "utf8");
  await writeFile(
    join(nestedSkillRoot, "SKILL.md"),
    "---\nname: nested-context\ndescription: Nested project context.\n---\n",
    "utf8",
  );
  let trustDocument: string | null = null;
  const workspaceTrust = createWorkspaceTrustWithStorageForTesting({
    workspaceRoot,
    storage: {
      async read() {
        return trustDocument === null
          ? { status: "missing" as const }
          : { status: "available" as const, text: trustDocument };
      },
      async write(text) {
        trustDocument = text;
      },
    },
  });
  let modelTurn = 0;
  const model = new FakeModelDriver(() => {
    modelTurn += 1;
    return modelTurn === 1
      ? [
          { type: "tool_call_start", id: "read-nested", name: "read_file" },
          {
            type: "tool_call_delta",
            id: "read-nested",
            json: JSON.stringify({ path: "nested/target.txt" }),
          },
          { type: "tool_call_end", id: "read-nested" },
          { type: "finish", reason: "tool_calls" },
        ]
      : [
          { type: "text_delta", text: "Revoked context stayed unavailable." },
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
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    tools: createReadToolRegistry({ workspaceRoot }),
    workspaceRoot,
    workspaceTrust,
  });
  const events: RuntimeEvent[] = [];
  lifecycle.subscribe((event) => events.push(event));

  try {
    const status = await lifecycle.inspectWorkspaceTrust();
    if (status.projectId === null) {
      throw new Error("The fixture requires one canonical project identity.");
    }
    await lifecycle.configureWorkspaceTrust({ type: "grant", projectId: status.projectId });
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.configureWorkspaceTrust({ type: "revoke", projectId: status.projectId });

    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Read the nested target without widening context." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "Revoked context stayed unavailable." },
      snapshot: {
        promptContext: { repository: { activeScopes: ["."] } },
        skillContext: { activeProjectScopes: ["."] },
      },
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_failed",
          callId: "read-nested",
          error: expect.objectContaining({ code: "project_context_unavailable" }),
        }),
      ]),
    );
    expect(events.some((event) => event.type === "repository_instructions_activated")).toBe(false);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("workspace trust never replaces MCP source, server, Profile, or effect authority", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-workspace-trust-mcp-authority-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: { type: "stdio", command: process.execPath, args: ["--version"], env: {} },
      },
    }),
    "utf8",
  );
  let trustDocument: string | null = null;
  const workspaceTrust = createWorkspaceTrustWithStorageForTesting({
    workspaceRoot,
    storage: {
      async read() {
        return trustDocument === null
          ? { status: "missing" as const }
          : { status: "available" as const, text: trustDocument };
      },
      async write(text) {
        trustDocument = text;
      },
    },
  });
  const peer = createScriptedMcpTransportFactory({
    fixture: {
      toolPages: [
        {
          tools: [
            {
              name: "echo",
              description: "Echo one value.",
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
            },
          ],
        },
      ],
    },
  });
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    [mcpTransportFactory]: peer,
    workspaceRoot,
    workspaceTrust,
  });

  try {
    const status = await lifecycle.inspectWorkspaceTrust();
    if (status.projectId === null) {
      throw new Error("The fixture requires one canonical project identity.");
    }
    await lifecycle.configureWorkspaceTrust({ type: "grant", projectId: status.projectId });
    const created = await lifecycle.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires an MCP configuration snapshot.");
    }
    const confirmed = await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });
    const server = confirmed.snapshot.mcp?.servers[0];
    if (server === undefined) {
      throw new Error("The fixture requires one MCP server preview.");
    }
    await lifecycle.configureMcp({
      type: "approve_server",
      sessionId: created.sessionId,
      serverId: server.serverId,
      definitionDigest: server.definitionDigest,
    });
    await lifecycle.configureWorkspaceTrust({ type: "revoke", projectId: status.projectId });

    await expect(
      lifecycle.configureMcp({
        type: "activate_servers",
        sessionId: created.sessionId,
        servers: [{ serverId: server.serverId, definitionDigest: server.definitionDigest }],
      }),
    ).rejects.toMatchObject({ code: "session_workspace_untrusted" });
    expect(peer.requests("fixture")).toEqual([]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("MCP configuration revalidates trust inside its mutation transaction", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-workspace-trust-mcp-race-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: { type: "stdio", command: process.execPath, args: ["--version"], env: {} },
      },
    }),
    "utf8",
  );
  let trustDocument: string | null = null;
  let revokeAfterRead = false;
  const workspaceTrust = createWorkspaceTrustWithStorageForTesting({
    workspaceRoot,
    storage: {
      async read() {
        const current = trustDocument;
        if (revokeAfterRead && current !== null) {
          revokeAfterRead = false;
          trustDocument = `${JSON.stringify({ schemaVersion: 1, trustedProjectIds: [] })}\n`;
        }
        return current === null
          ? { status: "missing" as const }
          : { status: "available" as const, text: current };
      },
      async write(text) {
        trustDocument = text;
      },
    },
  });
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    workspaceRoot,
    workspaceTrust,
  });

  try {
    const status = await lifecycle.inspectWorkspaceTrust();
    if (status.projectId === null) {
      throw new Error("The fixture requires one canonical project identity.");
    }
    await lifecycle.configureWorkspaceTrust({ type: "grant", projectId: status.projectId });
    const trustedDocument = trustDocument;
    const created = await lifecycle.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires one MCP source preview.");
    }
    revokeAfterRead = true;

    await expect(
      lifecycle.configureMcp({
        type: "confirm_workspace",
        sessionId: created.sessionId,
        sourceDigest: created.mcp.source.digest,
      }),
    ).rejects.toMatchObject({ code: "session_workspace_untrusted" });
    trustDocument = trustedDocument;
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      mcp: { workspaceConfirmed: false },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("revoking workspace trust closes active MCP before publishing untrusted state", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-workspace-trust-mcp-revoke-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: { type: "stdio", command: process.execPath, args: ["--version"], env: {} },
      },
    }),
    "utf8",
  );
  let trustDocument: string | null = null;
  let requireClosedTransport = false;
  let peer: ReturnType<typeof createScriptedMcpTransportFactory> | undefined;
  const workspaceTrust = createWorkspaceTrustWithStorageForTesting({
    workspaceRoot,
    storage: {
      async read() {
        return trustDocument === null
          ? { status: "missing" as const }
          : { status: "available" as const, text: trustDocument };
      },
      async write(text) {
        if (requireClosedTransport && peer?.activeCount("fixture") !== 0) {
          throw new Error("Workspace trust was published before the MCP transport closed.");
        }
        trustDocument = text;
      },
    },
  });
  peer = createScriptedMcpTransportFactory({
    fixture: {
      toolPages: [
        {
          tools: [
            {
              name: "echo",
              description: "Echo one value.",
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
            },
          ],
        },
      ],
    },
  });
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    [mcpTransportFactory]: peer,
    workspaceRoot,
    workspaceTrust,
  });

  try {
    const status = await lifecycle.inspectWorkspaceTrust();
    if (status.projectId === null) {
      throw new Error("The fixture requires one canonical project identity.");
    }
    await lifecycle.configureWorkspaceTrust({ type: "grant", projectId: status.projectId });
    const created = await lifecycle.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires an MCP configuration snapshot.");
    }
    const confirmed = await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });
    const server = confirmed.snapshot.mcp?.servers[0];
    if (server === undefined) {
      throw new Error("The fixture requires one MCP server preview.");
    }
    await lifecycle.configureMcp({
      type: "approve_server",
      sessionId: created.sessionId,
      serverId: server.serverId,
      definitionDigest: server.definitionDigest,
    });
    const activated = await lifecycle.configureMcp({
      type: "activate_servers",
      sessionId: created.sessionId,
      servers: [{ serverId: server.serverId, definitionDigest: server.definitionDigest }],
    });
    const activeMcp = activated.snapshot.mcp;
    if (activeMcp?.status !== "tool_selection_required") {
      throw new Error("The fixture requires one live MCP catalog.");
    }
    const echo = activeMcp.catalog?.tools[0];
    const generationId = activeMcp.activation?.generationId;
    if (echo === undefined || generationId === undefined) {
      throw new Error("The fixture requires one discovered MCP tool.");
    }
    await lifecycle.configureMcp({
      type: "commit_tool_profile",
      sessionId: created.sessionId,
      generationId,
      selections: [
        {
          qualifiedName: echo.qualifiedName,
          definitionDigest: echo.definitionDigest,
          effect: "read",
        },
      ],
    });

    const transportClosed = peer.nextClose("fixture");
    requireClosedTransport = true;
    await expect(
      lifecycle.configureWorkspaceTrust({ type: "revoke", projectId: status.projectId }),
    ).resolves.toMatchObject({ snapshot: { status: "untrusted" } });
    await transportClosed;
    expect(JSON.parse(trustDocument ?? "null")).toEqual({
      schemaVersion: 1,
      trustedProjectIds: [],
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a revoked historical session neither reactivates nor dispatches its MCP Profile", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-workspace-trust-mcp-history-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: { type: "stdio", command: process.execPath, args: ["--version"], env: {} },
      },
    }),
    "utf8",
  );
  let trustDocument: string | null = null;
  const workspaceTrust = createWorkspaceTrustWithStorageForTesting({
    workspaceRoot,
    storage: {
      async read() {
        return trustDocument === null
          ? { status: "missing" as const }
          : { status: "available" as const, text: trustDocument };
      },
      async write(text) {
        trustDocument = text;
      },
    },
  });
  const peer = createScriptedMcpTransportFactory({
    fixture: {
      toolPages: [
        {
          tools: [
            {
              name: "echo",
              description: "Echo one value.",
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
            },
          ],
        },
      ],
    },
  });
  let qualifiedName = "";
  let modelTurn = 0;
  const model = new FakeModelDriver(() => {
    modelTurn += 1;
    const requestsMcp = modelTurn === 1 || modelTurn === 3;
    const callId = modelTurn === 1 ? "revoked-mcp" : "retrusted-mcp";
    return requestsMcp
      ? [
          { type: "tool_call_start", id: callId, name: qualifiedName },
          {
            type: "tool_call_delta",
            id: callId,
            json: JSON.stringify({
              value: modelTurn === 1 ? "must-not-dispatch" : "dispatch-after-retrust",
            }),
          },
          { type: "tool_call_end", id: callId },
          { type: "finish", reason: "tool_calls" },
        ]
      : [
          {
            type: "text_delta",
            text:
              modelTurn === 2
                ? "Historical MCP stayed unavailable."
                : "Explicit re-trust restored MCP admission.",
          },
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
    [mcpTransportFactory]: peer,
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    tools: createReadToolRegistry({ workspaceRoot }),
    workspaceRoot,
    workspaceTrust,
  });

  try {
    const status = await lifecycle.inspectWorkspaceTrust();
    if (status.projectId === null) {
      throw new Error("The fixture requires one canonical project identity.");
    }
    await lifecycle.configureWorkspaceTrust({ type: "grant", projectId: status.projectId });
    const created = await lifecycle.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires an MCP configuration snapshot.");
    }
    const confirmed = await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });
    const server = confirmed.snapshot.mcp?.servers[0];
    if (server === undefined) {
      throw new Error("The fixture requires one MCP server preview.");
    }
    await lifecycle.configureMcp({
      type: "approve_server",
      sessionId: created.sessionId,
      serverId: server.serverId,
      definitionDigest: server.definitionDigest,
    });
    const activated = await lifecycle.configureMcp({
      type: "activate_servers",
      sessionId: created.sessionId,
      servers: [{ serverId: server.serverId, definitionDigest: server.definitionDigest }],
    });
    const activeMcp = activated.snapshot.mcp;
    if (activeMcp?.status !== "tool_selection_required") {
      throw new Error("The fixture requires one live MCP catalog.");
    }
    const echo = activeMcp.catalog?.tools[0];
    const generationId = activeMcp.activation?.generationId;
    if (echo === undefined || generationId === undefined) {
      throw new Error("The fixture requires one discovered MCP tool.");
    }
    qualifiedName = echo.qualifiedName;
    await lifecycle.configureMcp({
      type: "commit_tool_profile",
      sessionId: created.sessionId,
      generationId,
      selections: [
        {
          qualifiedName,
          definitionDigest: echo.definitionDigest,
          effect: "read",
        },
      ],
    });
    await lifecycle.configureWorkspaceTrust({ type: "revoke", projectId: status.projectId });
    const requestsBeforeContinue = peer.requests("fixture");

    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Try the historical MCP tool." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "Historical MCP stayed unavailable." },
    });
    expect(peer.requests("fixture")).toEqual(requestsBeforeContinue);
    await lifecycle.configureWorkspaceTrust({ type: "grant", projectId: status.projectId });
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Retry the historical MCP tool after explicit re-trust." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "Explicit re-trust restored MCP admission." },
    });
    expect(peer.requests("fixture")).toContainEqual({
      method: "tools/call",
      params: { name: "echo", arguments: { value: "dispatch-after-retrust" } },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("untrusted historical inspection never reads new mutable MCP configuration", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-workspace-trust-mcp-inspection-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let trustDocument: string | null = null;
  const workspaceTrust = createWorkspaceTrustWithStorageForTesting({
    workspaceRoot,
    storage: {
      async read() {
        return trustDocument === null
          ? { status: "missing" as const }
          : { status: "available" as const, text: trustDocument };
      },
      async write(text) {
        trustDocument = text;
      },
    },
  });
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ workspaceRoot, workspaceTrust });

  try {
    const status = await lifecycle.inspectWorkspaceTrust();
    if (status.projectId === null) {
      throw new Error("The fixture requires one canonical project identity.");
    }
    await lifecycle.configureWorkspaceTrust({ type: "grant", projectId: status.projectId });
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.configureWorkspaceTrust({ type: "revoke", projectId: status.projectId });
    await writeFile(join(workspaceRoot, ".mcp.json"), "not json\n", "utf8");

    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      schemaVersion: 3,
      sessionId: created.sessionId,
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("an untrusted draft preview excludes project Skills", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-workspace-trust-draft-"));
  const workspaceRoot = join(testRoot, "workspace");
  const projectSkillRoot = join(workspaceRoot, ".agents", "skills", "project-draft");
  await mkdir(projectSkillRoot, { recursive: true });
  await writeFile(
    join(projectSkillRoot, "SKILL.md"),
    "---\nname: project-draft\ndescription: Must not enter an untrusted draft.\n---\n",
    "utf8",
  );
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: targetIdentity,
        driver: new FakeModelDriver([]),
        contextProfile: officialProfile,
      };
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
  const workspaceTrust = createWorkspaceTrustWithStorageForTesting({
    workspaceRoot,
    storage: {
      async read() {
        return { status: "missing" };
      },
      async write() {
        throw new Error("The draft must not mutate workspace trust.");
      },
    },
  });
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, workspaceRoot, workspaceTrust });

  try {
    const preview = await lifecycle.previewNewSession({ targetIdentity });
    expect(preview.skillContext.catalog.entries).toEqual([]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});
