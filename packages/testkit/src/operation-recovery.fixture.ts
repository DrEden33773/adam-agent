const {
  createExtensionHost,
  createFileArtifactStore,
  createJsonlManagedAgentStore,
  createJsonlOperationStore,
  createJsonlSessionStoreDirectory,
  createPermissionPolicy,
} = await import("@adam-agent/agent");

const mode = requiredEnvironment("ADAM_AGENT_OPERATION_FIXTURE_MODE");
const packageRoot = requiredEnvironment("ADAM_AGENT_OPERATION_FIXTURE_PACKAGE_ROOT");
const stateRoot = requiredEnvironment("ADAM_AGENT_OPERATION_FIXTURE_STATE_ROOT");
const workspaceRoot = requiredEnvironment("ADAM_AGENT_OPERATION_FIXTURE_WORKSPACE_ROOT");
const artifactStore = await createFileArtifactStore({ root: `${stateRoot}/artifacts` });
const operationStore = await createJsonlOperationStore({ stateRoot, workspaceRoot });
const managedMode = mode.startsWith("managed-");
const targetIdentity = {
  targetId: "fixture.review.direct",
  vendor: "fixture",
  modelId: "review-model",
  route: "direct" as const,
  profileVersion: 1,
  certification: "certified" as const,
};
const childContextProfile = {
  version: 1 as const,
  contextWindowTokens: 128_000,
  maximumOutputTokens: 4_096,
  compactAtTokens: 96_000,
  postCompactTargetTokens: 32_000,
  retainedTargetTokens: 8_000,
  estimatorVersion: 1 as const,
};
const childModel = {
  async *stream(request: { readonly signal: AbortSignal }) {
    if (mode === "managed-wait-start") {
      await sendMessage({ type: "managed-model-started" });
      await new Promise<never>((_resolve, reject) => {
        const rejectAbort = () => reject(request.signal.reason);
        if (request.signal.aborted) rejectAbort();
        else request.signal.addEventListener("abort", rejectAbort, { once: true });
      });
    }
    yield { type: "text_delta" as const, text: '{"verdict":"verified"}' };
    yield { type: "usage" as const, inputTokens: 10, outputTokens: 3 };
    yield { type: "finish" as const, reason: "stop" as const };
  },
};
const host = createExtensionHost({
  artifactStore,
  capabilities: managedMode
    ? [
        { id: "adam.artifact.publish@1", version: "1.0.0" },
        { id: "adam.managed-session@2", version: "2.0.0" },
      ]
    : [
        { id: "adam.artifact.publish@1", version: "1.0.0" },
        { id: "adam.storage.records@1", version: "1.0.0" },
      ],
  extensions: [
    {
      enabled: true,
      extensionId: "fixture.extension",
      grants: managedMode
        ? [
            { id: "adam.artifact.publish@1", version: "^1.0.0" },
            { id: "adam.managed-session@2", version: "^2.0.0" },
          ]
        : [
            { id: "adam.artifact.publish@1", version: "^1.0.0" },
            { id: "adam.storage.records@1", version: "^1.0.0" },
          ],
      packageName: managedMode
        ? "@fixture/managed-v2-process-extension"
        : "@fixture/process-recovery-extension",
      packageRoot,
      packageVersion: "2.0.0",
    },
  ],
  ...(managedMode
    ? {
        managedSession: {
          childSessionStores: createJsonlSessionStoreDirectory({
            stateRoot: `${stateRoot}/managed-review-sessions`,
            workspaceRoot,
          }),
          managedStore: await createJsonlManagedAgentStore({ stateRoot, workspaceRoot }),
          parentPermissions: createPermissionPolicy({ allowedEffects: [] }),
          async resolveOrigin() {
            return { targetIdentity, childContextProfile, childModel };
          },
          workspaceRoot,
        },
        operationDeadlineMs: mode === "managed-deadline" ? 2_000 : 60_000,
        operationOriginAuthority: { validateBoundary: async () => true },
      }
    : {}),
  operationStore,
  projectRoot: workspaceRoot,
  stateRoot,
});

try {
  await host.loadConfiguredExtensions();
  if (mode === "managed-wait-start" || mode === "managed-deadline") {
    const started = await host.operations.startLinked({
      contributionId: "fixture.managed-review-v2",
      idempotencyKey: mode,
      input: { revision: mode },
      origin: {
        invocation: { id: "review", kind: "presentation_command", version: 1 },
        sessionId: "123e4567-e89b-42d3-a456-426614174099",
        sourceSequence: 3,
      },
    });
    const eventTypes: string[] = [];
    for await (const record of host.operations.events({ operationId: started.operationId })) {
      eventTypes.push(record.event.type);
      if (mode === "managed-wait-start" && record.event.type === "operation_managed_wait_started") {
        await sendMessage({
          type: "managed-wait-durable",
          operationId: started.operationId,
          eventTypes,
        });
      }
    }
    if (mode === "managed-deadline") {
      await sendAndDisconnect({
        type: "managed-deadline-terminal",
        eventTypes,
        snapshot: await host.operations.query(started.operationId),
      });
    }
  } else if (mode === "start") {
    await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "process-recovery-1",
      input: { revision: "process-recovery" },
    });
    await new Promise<void>(() => {});
  } else if (mode === "managed-query") {
    const operationId = requiredEnvironment("ADAM_AGENT_OPERATION_FIXTURE_OPERATION_ID");
    await sendAndDisconnect({
      type: "managed-query-completed",
      eventTypes: (await operationStore.read(operationId)).map((record) => record.event.type),
      snapshot: await host.operations.query(operationId),
    });
  } else {
    const operationId = requiredEnvironment("ADAM_AGENT_OPERATION_FIXTURE_OPERATION_ID");
    const snapshot = await host.operations.recover(operationId);
    await sendAndDisconnect({ type: "recovery-completed", snapshot });
  }
} catch (error) {
  await sendAndDisconnect({
    type: "recovery-error",
    code:
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "unknown",
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

async function sendAndDisconnect(message: unknown): Promise<void> {
  await sendMessage(message);
  process.disconnect();
}

async function sendMessage(message: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error === null) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}
