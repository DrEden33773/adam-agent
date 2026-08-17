import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createExtensionHost,
  createFileArtifactStore,
  createJsonlOperationStore,
  type OperationStore,
} from "@adam-agent/agent";
import { expect, test } from "vitest";

const cliPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

test("CLI recovers one exact configured operation from durable evidence", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-cli-operation-recovery-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const stateRoot = join(testRoot, "state");
  const configRoot = join(testRoot, "config");

  try {
    await mkdir(workspaceRoot);
    await writeCliRecoveryExtension(packageRoot);
    const artifactStore = await createFileArtifactStore({ root: join(stateRoot, "artifacts") });
    const durableStore = await createJsonlOperationStore({ stateRoot, workspaceRoot });
    let rejectOriginalTerminal = true;
    const interruptedStore: OperationStore = {
      ...(durableStore.projectId === undefined ? {} : { projectId: durableStore.projectId }),
      append(record) {
        if (rejectOriginalTerminal && record.event.type === "operation_completed") {
          rejectOriginalTerminal = false;
          return Promise.reject(new Error("injected original terminal persistence failure"));
        }
        return durableStore.append(record);
      },
      findByIdempotency: (scope) => durableStore.findByIdempotency(scope),
      read: (operationId) => durableStore.read(operationId),
    };
    const host = createExtensionHost({
      artifactStore,
      capabilities: [
        { id: "adam.artifact.publish@1", version: "1.0.0" },
        { id: "adam.storage.records@1", version: "1.0.0" },
      ],
      extensions: [configuredExtension(packageRoot)],
      operationStore: interruptedStore,
      projectRoot: workspaceRoot,
      stateRoot,
    });
    await host.loadConfiguredExtensions();
    const started = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "cli-recovery-1",
      input: { revision: "cli-recovery" },
    });
    for await (const _record of host.operations.events({ operationId: started.operationId })) {
      // Terminal-persistence interruption is the synchronization point.
    }
    const configDirectory = join(configRoot, "adam-agent");
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    const configPath = join(configDirectory, "extensions.json");
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 1, extensions: [configuredExtension(packageRoot)] }),
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(configPath, 0o600);

    const result = await runRecoveryCli({
      configRoot,
      operationId: started.operationId,
      stateRoot,
      workspaceRoot,
    });

    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: expect.any(String),
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      operationId: started.operationId,
      output: { accepted: true, revision: "cli-recovery" },
      status: "completed",
    });
    const beforeRepeat = await durableStore.read(started.operationId);
    const repeated = await runRecoveryCli({
      configRoot,
      operationId: started.operationId,
      stateRoot,
      workspaceRoot,
    });
    expect(repeated).toEqual(result);
    expect(await durableStore.read(started.operationId)).toEqual(beforeRepeat);

    rejectOriginalTerminal = true;
    const unsafeFailure = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "cli-recovery-secret-1",
      input: { revision: "throw-secret" },
    });
    for await (const _record of host.operations.events({
      operationId: unsafeFailure.operationId,
    })) {
      // The interrupted durable stream is the synchronization point.
    }
    await expect(
      runRecoveryCli({
        configRoot,
        operationId: unsafeFailure.operationId,
        stateRoot,
        workspaceRoot,
      }),
    ).resolves.toEqual({
      exitCode: 1,
      signal: null,
      stderr: "The operation reconciliation failed safely.\n",
      stdout: "",
    });
    expect(
      (await durableStore.read(started.operationId)).map((record) => record.event.type),
    ).toEqual([
      "operation_started",
      "operation_artifact_published",
      "operation_reconciliation_started",
      "operation_completed",
    ]);

    const symlinkedConfigRoot = join(testRoot, "symlinked-config");
    await mkdir(symlinkedConfigRoot);
    await symlink(configDirectory, join(symlinkedConfigRoot, "adam-agent"), "dir");
    await expect(
      runRecoveryCli({
        configRoot: symlinkedConfigRoot,
        operationId: started.operationId,
        stateRoot,
        workspaceRoot,
      }),
    ).resolves.toEqual({
      exitCode: 1,
      signal: null,
      stderr: "The Owner extension configuration is not an owner-only ordinary file.\n",
      stdout: "",
    });
    await expect(
      runRecoveryCli({
        configRoot,
        operationId: "not-a-uuid",
        stateRoot,
        workspaceRoot,
      }),
    ).resolves.toEqual({
      exitCode: 1,
      signal: null,
      stderr: "Usage: adam-agent --recover-operation <operation-id>\n",
      stdout: "",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

function configuredExtension(packageRoot: string) {
  return {
    configuration: null,
    enabled: true,
    extensionId: "fixture.extension",
    grants: [
      { id: "adam.artifact.publish@1", version: "^1.0.0" },
      { id: "adam.storage.records@1", version: "^1.0.0" },
    ],
    packageName: "@fixture/cli-recovery-extension",
    packageRoot,
    packageVersion: "2.0.0",
  } as const;
}

async function runRecoveryCli(options: {
  readonly configRoot: string;
  readonly operationId: string;
  readonly stateRoot: string;
  readonly workspaceRoot: string;
}): Promise<{
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "--recover-operation", options.operationId], {
      cwd: options.workspaceRoot,
      env: {
        ...process.env,
        ADAM_AGENT_STATE_ROOT: options.stateRoot,
        XDG_CONFIG_HOME: options.configRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const guard = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(guard);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(guard);
      if (timedOut) {
        reject(new Error("The recovery CLI did not reach process closure."));
        return;
      }
      resolve({ exitCode, signal, stderr, stdout });
    });
  });
}

async function writeCliRecoveryExtension(packageRoot: string): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/cli-recovery-extension",
      version: "2.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.extension",
        apiVersion: "^0.2.0",
        runtime: { entry: "./runtime.js" },
        capabilities: {
          required: [
            { id: "adam.artifact.publish@1", version: "^1.0.0" },
            { id: "adam.storage.records@1", version: "^1.0.0" },
          ],
          optional: [],
        },
        contributions: [
          {
            kind: "operation",
            id: "fixture.review",
            input: { id: "fixture.input", version: 1 },
            output: { id: "fixture.output", version: 1 },
            progress: { id: "fixture.progress", version: 1 },
            recovery: { version: 1 },
          },
        ],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "runtime.js"),
    `export function activate(context) {
  const codec = (id) => ({
    id,
    version: 1,
    decode(value) { return { ok: true, value }; },
    encode(value) { return { ok: true, value }; },
  });
  context.registerOperation({
    id: "fixture.review",
    input: codec("fixture.input"),
    output: codec("fixture.output"),
    progress: codec("fixture.progress"),
    async execute(input, operation) {
      const output = { accepted: true, revision: input.revision };
      const artifact = await operation.capabilities["adam.artifact.publish@1"].publish({
        bytes: new TextEncoder().encode(JSON.stringify(output)),
        contract: { id: "fixture.complete-report", version: 1 },
        mediaType: "application/json",
      });
      await operation.capabilities["adam.storage.records@1"].create({
        key: \`operations/\${operation.operationId}\`,
        contract: { id: "fixture.review-aggregate", version: 1 },
        value: { artifact, output, status: "completed" },
      });
      return output;
    },
    async reconcile(input, operation) {
      if (input.revision === "throw-secret") {
        throw new Error("SECRET /private/extension/path must not escape");
      }
      const record = await operation.evidence.records.get(\`operations/\${operation.operationId}\`);
      const bytes = await operation.evidence.artifacts.read(record.value.artifact);
      return {
        status: "completed",
        output: JSON.parse(new TextDecoder().decode(bytes)),
        artifacts: [record.value.artifact],
      };
    },
  });
}
`,
    "utf8",
  );
}
