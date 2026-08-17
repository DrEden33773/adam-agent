const { createExtensionHost, createFileArtifactStore, createJsonlOperationStore } = await import(
  "@adam-agent/agent"
);

const mode = requiredEnvironment("ADAM_AGENT_OPERATION_FIXTURE_MODE");
const packageRoot = requiredEnvironment("ADAM_AGENT_OPERATION_FIXTURE_PACKAGE_ROOT");
const stateRoot = requiredEnvironment("ADAM_AGENT_OPERATION_FIXTURE_STATE_ROOT");
const workspaceRoot = requiredEnvironment("ADAM_AGENT_OPERATION_FIXTURE_WORKSPACE_ROOT");
const artifactStore = await createFileArtifactStore({ root: `${stateRoot}/artifacts` });
const operationStore = await createJsonlOperationStore({ stateRoot, workspaceRoot });
const host = createExtensionHost({
  artifactStore,
  capabilities: [
    { id: "adam.artifact.publish@1", version: "1.0.0" },
    { id: "adam.storage.records@1", version: "1.0.0" },
  ],
  extensions: [
    {
      enabled: true,
      extensionId: "fixture.extension",
      grants: [
        { id: "adam.artifact.publish@1", version: "^1.0.0" },
        { id: "adam.storage.records@1", version: "^1.0.0" },
      ],
      packageName: "@fixture/process-recovery-extension",
      packageRoot,
      packageVersion: "2.0.0",
    },
  ],
  operationStore,
  projectRoot: workspaceRoot,
  stateRoot,
});

try {
  await host.loadConfiguredExtensions();
  if (mode === "start") {
    await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "process-recovery-1",
      input: { revision: "process-recovery" },
    });
    await new Promise<void>(() => {});
  }
  const operationId = requiredEnvironment("ADAM_AGENT_OPERATION_FIXTURE_OPERATION_ID");
  const snapshot = await host.operations.recover(operationId);
  await sendAndDisconnect({ type: "recovery-completed", snapshot });
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
  await new Promise<void>((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error === null) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
  process.disconnect();
}
