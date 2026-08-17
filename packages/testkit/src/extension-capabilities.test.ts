import { mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ArtifactStore,
  createBiomeExecutionAdapter,
  createExtensionHost,
  createFileArtifactStore,
  createInMemoryOperationStore,
  createPermissionPolicy,
} from "@adam-agent/agent";
import { expect, test } from "vitest";

test.each(["adam.artifact.publish@1", "adam.analyzer-execution.biome@1"])(
  "ExtensionHost rejects advertised %s without its production broker",
  (capabilityId) => {
    expect(() =>
      createExtensionHost({
        capabilities: [{ id: capabilityId, version: "1.0.0" }],
        extensions: [],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "extension_configuration_invalid",
        name: "ExtensionHostError",
      }),
    );
  },
);

test("ExtensionHost rejects a Biome broker without a PermissionPolicy", () => {
  expect(() =>
    createExtensionHost({
      biomeExecution: {
        async execute() {
          throw new Error("The invalid Host must not execute Biome.");
        },
      },
      capabilities: [{ id: "adam.analyzer-execution.biome@1", version: "1.0.0" }],
      extensions: [],
    }),
  ).toThrow(
    expect.objectContaining({
      code: "extension_configuration_invalid",
      name: "ExtensionHostError",
    }),
  );
});

test("ExtensionHost makes artifact bytes durable before publishing their operation reference", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-extension-artifact-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const artifactStore = await createFileArtifactStore({ root: join(testRoot, "artifacts") });
  const controlKey = `__adamArtifactCapability${Date.now()}${Math.random()}`;
  let reportPublished = (_summary: unknown) => {};
  let releaseHandler = () => {};
  const published = new Promise<unknown>((resolve) => {
    reportPublished = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  (globalThis as Record<string, unknown>)[controlKey] = { release, reportPublished };

  try {
    await mkdir(workspaceRoot);
    await writeArtifactExtension(packageRoot, controlKey);
    const host = createExtensionHost({
      artifactStore,
      capabilities: [{ id: "adam.artifact.publish@1", version: "1.0.0" }],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [{ id: "adam.artifact.publish@1", version: "^1.0.0" }],
          packageName: "@fixture/artifact-extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: createInMemoryOperationStore(),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();
    const started = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "artifact-before-reference-1",
      input: { revision: "abc123" },
    });
    const recordsPromise = collectOperationEvents(host, started.operationId);
    const firstObservable = await Promise.race([
      published.then((summary) => ({ kind: "published" as const, summary })),
      recordsPromise.then((records) => ({ kind: "terminal" as const, records })),
    ]);

    expect(firstObservable.kind).toBe("published");
    if (firstObservable.kind !== "published") {
      throw new Error("The operation terminated before artifact publication succeeded.");
    }
    const summary = firstObservable.summary as {
      readonly byteCount: number;
      readonly contract: { readonly id: string; readonly version: number };
      readonly id: string;
      readonly mediaType: string;
      readonly provenance: {
        readonly contributionId: string;
        readonly extensionId: string;
        readonly extensionVersion: string;
        readonly operationId: string;
        readonly projectId: string;
      };
    };
    await expect(artifactStore.read(summary.id)).resolves.toEqual(Buffer.from("review-result"));
    await expect(host.operations.query(started.operationId)).resolves.toMatchObject({
      status: "running",
    });
    expect(summary).toEqual({
      byteCount: 13,
      contract: { id: "fixture.review-result", version: 1 },
      id: "sha256:533caf6e8ff7bb7489e0b64fdff813b635dfb5abc30b387b79e13000ebd268c5",
      mediaType: "application/json",
      provenance: {
        contributionId: "fixture.review",
        extensionId: "fixture.extension",
        extensionVersion: "1.0.0",
        operationId: started.operationId,
        projectId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
    });

    releaseHandler();
    await expect(recordsPromise).resolves.toMatchObject([
      { event: { type: "operation_started" } },
      { event: { artifact: summary, type: "operation_artifact_published" } },
      { event: { output: { artifact: summary }, type: "operation_completed" } },
    ]);
  } finally {
    delete (globalThis as Record<string, unknown>)[controlKey];
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost fails an operation when its handler catches an artifact limit failure", async () => {
  await expectCaughtArtifactLimitFailure(
    "adam-agent-extension-artifact-limit-",
    "artifact-limit-caught-1",
    writeArtifactLimitExtension,
  );
});

test("ExtensionHost limits each operation to eight artifacts", async () => {
  await expectCaughtArtifactLimitFailure(
    "adam-agent-extension-artifact-count-",
    "artifact-count-caught-1",
    writeArtifactCountExtension,
  );
});

test("ExtensionHost limits artifact bytes to sixteen mebibytes per operation", async () => {
  await expectCaughtArtifactLimitFailure(
    "adam-agent-extension-artifact-aggregate-",
    "artifact-aggregate-caught-1",
    writeArtifactAggregateLimitExtension,
  );
});

test("ExtensionHost fails an operation when artifact persistence fails", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-extension-artifact-persistence-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const artifactRoot = join(testRoot, "artifacts");
  const artifactStore = await createFileArtifactStore({ root: artifactRoot });

  try {
    await mkdir(workspaceRoot);
    await writeCaughtArtifactPublishExtension(packageRoot);
    await rm(artifactRoot, { recursive: true });
    await writeFile(artifactRoot, "not-a-directory", "utf8");
    const host = createExtensionHost({
      artifactStore,
      capabilities: [{ id: "adam.artifact.publish@1", version: "1.0.0" }],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [{ id: "adam.artifact.publish@1", version: "^1.0.0" }],
          packageName: "@fixture/artifact-extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: createInMemoryOperationStore(),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();
    const started = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "artifact-persistence-caught-1",
      input: null,
    });

    await expect(collectOperationEvents(host, started.operationId)).resolves.toMatchObject([
      { event: { type: "operation_started" } },
      {
        event: {
          error: {
            code: "operation_capability_persistence_failed",
            message: "The operation could not persist an artifact.",
          },
          type: "operation_failed",
        },
      },
    ]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost denies a late artifact result while retaining its cancelled reference", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-extension-artifact-cancel-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const controlKey = `__adamCancelledArtifact${Date.now()}${Math.random()}`;
  let signalWriteStarted = () => {};
  let releaseWrite = () => {};
  let signalCapabilitySettled = (_status: "rejected" | "resolved") => {};
  const writeStarted = new Promise<void>((resolve) => {
    signalWriteStarted = resolve;
  });
  const writeRelease = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const capabilitySettled = new Promise<"rejected" | "resolved">((resolve) => {
    signalCapabilitySettled = resolve;
  });
  (globalThis as Record<string, unknown>)[controlKey] = {
    settled: signalCapabilitySettled,
  };
  const artifactId = "sha256:533caf6e8ff7bb7489e0b64fdff813b635dfb5abc30b387b79e13000ebd268c5";
  const artifactStore: ArtifactStore = {
    async read(id) {
      return id === artifactId ? new TextEncoder().encode("review-result") : undefined;
    },
    async write(input) {
      signalWriteStarted();
      await writeRelease;
      return {
        byteCount: input.bytes.byteLength,
        id: artifactId,
        mediaType: input.mediaType,
        source: input.source,
      };
    },
  };

  try {
    await mkdir(workspaceRoot);
    await writeCancelledArtifactExtension(packageRoot, controlKey);
    const host = createExtensionHost({
      artifactStore,
      capabilities: [{ id: "adam.artifact.publish@1", version: "1.0.0" }],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [{ id: "adam.artifact.publish@1", version: "^1.0.0" }],
          packageName: "@fixture/artifact-extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: createInMemoryOperationStore(),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();
    const started = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "artifact-cancelled-late-result-1",
      input: null,
    });
    const eventsPromise = collectOperationEvents(host, started.operationId);
    await writeStarted;
    await host.operations.cancel(started.operationId);
    releaseWrite();

    const events = await eventsPromise;
    expect(await capabilitySettled).toBe("rejected");
    expect(events).toMatchObject([
      { event: { type: "operation_started" } },
      { event: { reason: "caller", type: "operation_cancel_requested" } },
      { event: { type: "operation_artifact_published" } },
      {
        event: {
          artifacts: [
            {
              byteCount: 13,
              contract: { id: "fixture.review-result", version: 1 },
              id: artifactId,
              mediaType: "application/json",
              provenance: {
                contributionId: "fixture.review",
                extensionId: "fixture.extension",
                extensionVersion: "1.0.0",
                operationId: started.operationId,
                projectId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
              },
            },
          ],
          reason: "caller",
          type: "operation_cancelled",
        },
      },
    ]);
  } finally {
    delete (globalThis as Record<string, unknown>)[controlKey];
    releaseWrite();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost retains a published artifact reference when the handler later fails", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-extension-artifact-failed-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const artifactStore = await createFileArtifactStore({ root: join(testRoot, "artifacts") });

  try {
    await mkdir(workspaceRoot);
    await writeArtifactThenFailExtension(packageRoot);
    const host = createExtensionHost({
      artifactStore,
      capabilities: [{ id: "adam.artifact.publish@1", version: "1.0.0" }],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [{ id: "adam.artifact.publish@1", version: "^1.0.0" }],
          packageName: "@fixture/artifact-extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: createInMemoryOperationStore(),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();
    const started = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "artifact-before-failure-1",
      input: null,
    });
    const events = await collectOperationEvents(host, started.operationId);

    expect(events).toMatchObject([
      { event: { type: "operation_started" } },
      { event: { type: "operation_artifact_published" } },
      {
        event: {
          artifacts: [
            {
              contract: { id: "fixture.review-result", version: 1 },
              id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
            },
          ],
          error: {
            code: "extension_execution_failed",
            message: "The extension operation failed.",
          },
          type: "operation_failed",
        },
      },
    ]);
    const terminal = events.at(-1)?.event;
    if (terminal?.type !== "operation_failed") {
      throw new Error("The fixture operation did not fail after publishing its artifact.");
    }
    await expect(host.operations.query(started.operationId)).resolves.toMatchObject({
      artifacts: terminal.artifacts,
      status: "failed",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost confines immutable records and lists their durable summaries", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-extension-records-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeRecordExtension(packageRoot);
    const host = createExtensionHost({
      capabilities: [{ id: "adam.storage.records@1", version: "1.0.0" }],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [{ id: "adam.storage.records@1", version: "^1.0.0" }],
          packageName: "@fixture/artifact-extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: createInMemoryOperationStore(),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();
    const started = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "record-create-get-list-1",
      input: null,
    });
    const records = await collectOperationEvents(host, started.operationId);
    const projectId = expect.stringMatching(/^sha256:[0-9a-f]{64}$/u);
    const summary = {
      byteCount: 19,
      contract: { id: "fixture.review-record", version: 1 },
      digest: "sha256:3efd990bffc66438518df5f09b985577f57564cdac42745ba655e9bd79e19528",
      key: `operations/${started.operationId}`,
      provenance: {
        contributionId: "fixture.review",
        extensionId: "fixture.extension",
        extensionVersion: "1.0.0",
        operationId: started.operationId,
        projectId,
      },
    };

    expect(records).toMatchObject([
      { event: { type: "operation_started" } },
      {
        event: {
          output: {
            created: summary,
            found: { ...summary, value: { outcome: "clean" } },
            listed: { records: [summary] },
          },
          type: "operation_completed",
        },
      },
    ]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost record cursors preserve every key in canonical order", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-extension-record-pagination-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeRecordPaginationExtension(packageRoot);
    const host = createExtensionHost({
      capabilities: [{ id: "adam.storage.records@1", version: "1.0.0" }],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [{ id: "adam.storage.records@1", version: "^1.0.0" }],
          packageName: "@fixture/artifact-extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: createInMemoryOperationStore(),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();
    const started = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "record-pagination-1",
      input: null,
    });
    const terminal = (await collectOperationEvents(host, started.operationId)).at(-1)?.event;

    expect(terminal).toMatchObject({
      output: {
        keys: ["records/A", "records/Z", "records/a", "records/z"],
      },
      type: "operation_completed",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each(["create", "get", "list"] as const)(
  "ExtensionHost denies a late records.%s result after cancellation",
  async (method) => {
    const testRoot = await mkdtemp(join(tmpdir(), `adam-agent-extension-record-${method}-cancel-`));
    const workspaceRoot = join(testRoot, "workspace");
    const packageRoot = join(testRoot, "extension");
    const controlKey = `__adamCancelledRecord${Date.now()}${Math.random()}`;
    let signalCapabilityStarted = () => {};
    let signalCapabilitySettled = (_status: "rejected" | "resolved") => {};
    const capabilityStarted = new Promise<void>((resolve) => {
      signalCapabilityStarted = resolve;
    });
    const capabilitySettled = new Promise<"rejected" | "resolved">((resolve) => {
      signalCapabilitySettled = resolve;
    });
    (globalThis as Record<string, unknown>)[controlKey] = {
      settled: signalCapabilitySettled,
      started: signalCapabilityStarted,
    };

    try {
      await mkdir(workspaceRoot);
      await writeDeferredRecordExtension(packageRoot, controlKey);
      const host = createExtensionHost({
        capabilities: [{ id: "adam.storage.records@1", version: "1.0.0" }],
        extensions: [
          {
            enabled: true,
            extensionId: "fixture.extension",
            grants: [{ id: "adam.storage.records@1", version: "^1.0.0" }],
            packageName: "@fixture/artifact-extension",
            packageRoot,
            packageVersion: "1.0.0",
          },
        ],
        operationStore: createInMemoryOperationStore(),
        projectRoot: workspaceRoot,
        stateRoot: join(testRoot, "state"),
      });
      await host.loadConfiguredExtensions();
      if (method !== "create") {
        const seed = await host.operations.start({
          contributionId: "fixture.review",
          idempotencyKey: `record-${method}-seed-1`,
          input: { mode: "seed" },
        });
        await expect(collectOperationEvents(host, seed.operationId)).resolves.toMatchObject([
          { event: { type: "operation_started" } },
          { event: { type: "operation_completed" } },
        ]);
      }
      const started = await host.operations.start({
        contributionId: "fixture.review",
        idempotencyKey: `record-${method}-cancel-1`,
        input: { mode: method },
      });
      const eventsPromise = collectOperationEvents(host, started.operationId);
      await capabilityStarted;
      await host.operations.cancel(started.operationId);
      const events = await eventsPromise;

      expect(await capabilitySettled).toBe("rejected");
      expect(events).toMatchObject([
        { event: { type: "operation_started" } },
        { event: { reason: "caller", type: "operation_cancel_requested" } },
        { event: { reason: "caller", type: "operation_cancelled" } },
      ]);
      if (method === "create") {
        const verify = await host.operations.start({
          contributionId: "fixture.review",
          idempotencyKey: "record-create-verify-1",
          input: { mode: "verify" },
        });
        await expect(collectOperationEvents(host, verify.operationId)).resolves.toMatchObject([
          { event: { type: "operation_started" } },
          {
            event: {
              output: { found: { key: "records/shared" } },
              type: "operation_completed",
            },
          },
        ]);
      }
    } finally {
      delete (globalThis as Record<string, unknown>)[controlKey];
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test("ExtensionHost preserves create-if-absent record conflicts as terminal truth", async () => {
  await expectRecordCapabilityFailure(
    "adam-agent-extension-record-conflict-",
    "record-conflict-caught-1",
    writeRecordConflictExtension,
    {
      code: "operation_capability_conflict",
      message: "The immutable extension record already exists.",
    },
  );
});

test("ExtensionHost rejects non-canonical record keys without escaping the namespace", async () => {
  await expectRecordCapabilityFailure(
    "adam-agent-extension-record-key-",
    "record-key-caught-1",
    writeInvalidRecordKeyExtension,
    {
      code: "operation_capability_input_invalid",
      message: "The operation supplied invalid capability input.",
    },
  );
});

test("ExtensionHost limits each immutable record to six megabytes", async () => {
  await expectRecordCapabilityFailure(
    "adam-agent-extension-record-size-",
    "record-size-caught-1",
    writeOversizedRecordExtension,
    {
      code: "operation_capability_limit_exceeded",
      message: "The operation exceeded a record capability limit.",
    },
  );
});

test("ExtensionHost limits each operation to sixteen immutable record creates", async () => {
  await expectRecordCapabilityFailure(
    "adam-agent-extension-record-count-",
    "record-count-caught-1",
    writeRecordCountLimitExtension,
    {
      code: "operation_capability_limit_exceeded",
      message: "The operation exceeded a record capability limit.",
    },
  );
});

test("ExtensionHost limits record bytes to eight megabytes per operation", async () => {
  await expectRecordCapabilityFailure(
    "adam-agent-extension-record-aggregate-",
    "record-aggregate-caught-1",
    writeRecordAggregateLimitExtension,
    {
      code: "operation_capability_limit_exceeded",
      message: "The operation exceeded a record capability limit.",
    },
  );
});

test("ExtensionHost brokers one fixed Biome profile through bounded snapshots", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-extension-biome-adapter-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  let received: unknown;
  const biomeExecution = {
    async execute(input: unknown) {
      received = input;
      return {
        analyzerVersion: "2.5.8",
        exitCode: 1,
        report: new TextEncoder().encode(
          JSON.stringify({
            command: "check",
            diagnostics: [{ category: "lint/suspicious/noDoubleEquals", severity: "error" }],
            summary: { errors: 1, warnings: 0 },
          }),
        ),
        stderr: new TextEncoder().encode("bounded warning"),
        stdout: new Uint8Array(),
      };
    },
  };

  try {
    await mkdir(workspaceRoot);
    await writeBiomeExtension(packageRoot);
    const options = {
      biomeExecution,
      capabilities: [{ id: "adam.analyzer-execution.biome@1", version: "1.0.0" }],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [{ id: "adam.analyzer-execution.biome@1", version: "^1.0.0" }],
          packageName: "@fixture/artifact-extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: createInMemoryOperationStore(),
      permissions: createPermissionPolicy({ allowedEffects: ["execute"] }),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    };
    const host = createExtensionHost(options);
    await host.loadConfiguredExtensions();
    const started = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "biome-fixed-profile-1",
      input: null,
    });
    const events = await collectOperationEvents(host, started.operationId);

    expect(received).toMatchObject({
      deadlineAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      files: [
        { content: "const answer = 42;\n", path: "src/good.ts" },
        { content: "if (answer == '42') {}\n", path: "src/bad.ts" },
      ],
      profile: "adam-biome-recommended-v1",
      signal: expect.any(AbortSignal),
    });
    expect(Object.keys(received as object).sort()).toEqual([
      "deadlineAt",
      "files",
      "profile",
      "signal",
    ]);
    expect(events).toMatchObject([
      { event: { type: "operation_started" } },
      {
        event: {
          output: {
            analysis: {
              execution: {
                analyzer: "biome",
                analyzerVersion: "2.5.8",
                exitCode: 1,
                profile: "adam-biome-recommended-v1",
                provenance: {
                  contributionId: "fixture.review",
                  extensionId: "fixture.extension",
                  extensionVersion: "1.0.0",
                  operationId: started.operationId,
                  projectId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
                },
              },
              report: {
                command: "check",
                diagnostics: [{ category: "lint/suspicious/noDoubleEquals", severity: "error" }],
                summary: { errors: 1, warnings: 0 },
              },
            },
          },
          type: "operation_completed",
        },
      },
    ]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each(["ask", "deny"] as const)(
  "ExtensionHost fails closed on a %s Biome PermissionPolicy decision before execution",
  async (decision) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-extension-biome-denied-"));
    const workspaceRoot = join(testRoot, "workspace");
    const packageRoot = join(testRoot, "extension");
    const decisions: unknown[] = [];
    let executionCount = 0;

    try {
      await mkdir(workspaceRoot);
      await writeBiomeExtension(packageRoot);
      const options = {
        biomeExecution: {
          async execute() {
            executionCount += 1;
            throw new Error("The denied Biome Adapter must not execute.");
          },
        },
        capabilities: [{ id: "adam.analyzer-execution.biome@1", version: "1.0.0" }],
        extensions: [
          {
            enabled: true,
            extensionId: "fixture.extension",
            grants: [{ id: "adam.analyzer-execution.biome@1", version: "^1.0.0" }],
            packageName: "@fixture/artifact-extension",
            packageRoot,
            packageVersion: "1.0.0",
          },
        ],
        operationStore: createInMemoryOperationStore(),
        permissions: {
          decide(input: unknown) {
            decisions.push(input);
            return decision;
          },
        },
        projectRoot: workspaceRoot,
        stateRoot: join(testRoot, "state"),
      };
      const host = createExtensionHost(options);
      await host.loadConfiguredExtensions();
      const started = await host.operations.start({
        contributionId: "fixture.review",
        idempotencyKey: "biome-effect-denied-1",
        input: null,
      });
      const events = await collectOperationEvents(host, started.operationId);

      expect(executionCount).toBe(0);
      expect(decisions).toEqual([
        {
          callId: `${started.operationId}:biome:1`,
          effect: "execute",
          name: "adam.analyzer-execution.biome@1",
          scope: "call",
          subject: {
            capabilityId: "adam.analyzer-execution.biome@1",
            contributionId: "fixture.review",
            extensionId: "fixture.extension",
            extensionVersion: "1.0.0",
            operationId: started.operationId,
            type: "extension_capability",
          },
        },
      ]);
      expect(events).toMatchObject([
        { event: { type: "operation_started" } },
        {
          event: {
            error: {
              code: "operation_capability_permission_denied",
              message: "The Biome analyzer execution was denied by policy.",
            },
            type: "operation_failed",
          },
        },
      ]);
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test("ExtensionHost runs the locked Biome profile on real Linux", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-extension-biome-linux-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeFile(
      join(workspaceRoot, "biome.json"),
      JSON.stringify({ linter: { enabled: false } }),
      "utf8",
    );
    await writeBiomeExtension(packageRoot);
    const host = createExtensionHost({
      biomeExecution: createBiomeExecutionAdapter(),
      capabilities: [{ id: "adam.analyzer-execution.biome@1", version: "1.0.0" }],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [{ id: "adam.analyzer-execution.biome@1", version: "^1.0.0" }],
          packageName: "@fixture/artifact-extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: createInMemoryOperationStore(),
      permissions: createPermissionPolicy({ allowedEffects: ["execute"] }),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();
    const started = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "biome-real-linux-1",
      input: null,
    });
    const events = await collectOperationEvents(host, started.operationId);

    expect(events).toMatchObject([
      { event: { type: "operation_started" } },
      {
        event: {
          output: {
            analysis: {
              execution: {
                analyzer: "biome",
                analyzerVersion: "2.5.8",
                exitCode: 1,
                profile: "adam-biome-recommended-v1",
              },
              report: {
                diagnostics: expect.arrayContaining([
                  expect.objectContaining({
                    category: "lint/suspicious/noDoubleEquals",
                    severity: "error",
                  }),
                ]),
              },
            },
          },
          type: "operation_completed",
        },
      },
    ]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost enforces the real Biome stdout limit independently of the report limit", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-extension-biome-stdout-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeNoisyBiomeExtension(packageRoot);
    const host = createExtensionHost({
      biomeExecution: createBiomeExecutionAdapter(),
      capabilities: [{ id: "adam.analyzer-execution.biome@1", version: "1.0.0" }],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [{ id: "adam.analyzer-execution.biome@1", version: "^1.0.0" }],
          packageName: "@fixture/artifact-extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: createInMemoryOperationStore(),
      permissions: createPermissionPolicy({ allowedEffects: ["execute"] }),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();
    const started = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "biome-stdout-limit-1",
      input: null,
    });

    await expect(collectOperationEvents(host, started.operationId)).resolves.toMatchObject([
      { event: { type: "operation_started" } },
      {
        event: {
          error: {
            code: "operation_capability_execution_failed",
            message: "The Biome analyzer execution failed.",
          },
          type: "operation_failed",
        },
      },
    ]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
}, 20_000);

test("ExtensionHost closes the real Biome process and removes its snapshot on cancellation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-extension-biome-cancel-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const existingTemporaryRoots = new Set(await listBiomeTemporaryRoots());
  let host: ReturnType<typeof createExtensionHost> | undefined;
  let operationId: string | undefined;
  let eventsPromise: ReturnType<typeof collectOperationEvents> | undefined;

  try {
    await mkdir(workspaceRoot);
    await writeLongRunningBiomeExtension(packageRoot);
    host = createExtensionHost({
      biomeExecution: createBiomeExecutionAdapter(),
      capabilities: [{ id: "adam.analyzer-execution.biome@1", version: "1.0.0" }],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [{ id: "adam.analyzer-execution.biome@1", version: "^1.0.0" }],
          packageName: "@fixture/artifact-extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: createInMemoryOperationStore(),
      permissions: createPermissionPolicy({ allowedEffects: ["execute"] }),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();
    const started = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "biome-real-cancellation-1",
      input: null,
    });
    operationId = started.operationId;
    eventsPromise = collectOperationEvents(host, operationId);
    const snapshotRoot = await waitForValue(async () => {
      const created = (await listBiomeTemporaryRoots()).find(
        (path) => !existingTemporaryRoots.has(path),
      );
      return created;
    }, "Biome did not create its temporary snapshot.");
    const childPid = await waitForValue(
      () => findChildWithWorkingDirectory(join(snapshotRoot, "snapshot")),
      "Biome did not start a real child process.",
    );

    await host.operations.cancel(started.operationId);
    const events = await eventsPromise;

    expect(events).toMatchObject([
      { event: { type: "operation_started" } },
      { event: { reason: "caller", type: "operation_cancel_requested" } },
      { event: { reason: "caller", type: "operation_cancelled" } },
    ]);
    await expect(stat(`/proc/${childPid}`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(snapshotRoot)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (host !== undefined && operationId !== undefined) {
      await host.operations.cancel(operationId).catch(() => undefined);
      await eventsPromise?.catch(() => undefined);
    }
    await rm(testRoot, { recursive: true, force: true });
  }
}, 20_000);

test("a literal non-Eve extension composes Biome, artifacts, and immutable records", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-extension-conformance-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const artifactStore = await createFileArtifactStore({ root: join(testRoot, "artifacts") });
  const biomeExecution = {
    async execute() {
      return {
        analyzerVersion: "2.5.8",
        exitCode: 0,
        report: new TextEncoder().encode(
          JSON.stringify({
            command: "check",
            diagnostics: [],
            summary: { errors: 0, warnings: 0 },
          }),
        ),
        stderr: new Uint8Array(),
        stdout: new Uint8Array(),
      };
    },
  };

  try {
    await mkdir(workspaceRoot);
    await writeConformanceExtension(packageRoot);
    const host = createExtensionHost({
      artifactStore,
      biomeExecution,
      capabilities: [
        { id: "adam.analyzer-execution.biome@1", version: "1.0.0" },
        { id: "adam.artifact.publish@1", version: "1.0.0" },
        { id: "adam.storage.records@1", version: "1.0.0" },
      ],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [
            { id: "adam.analyzer-execution.biome@1", version: "^1.0.0" },
            { id: "adam.artifact.publish@1", version: "^1.0.0" },
            { id: "adam.storage.records@1", version: "^1.0.0" },
          ],
          packageName: "@fixture/artifact-extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: createInMemoryOperationStore(),
      permissions: createPermissionPolicy({ allowedEffects: ["execute"] }),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();
    const started = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "literal-conformance-1",
      input: { files: 1 },
    });
    const events = await collectOperationEvents(host, started.operationId);
    const terminal = events.at(-1)?.event;
    expect(terminal).toMatchObject({
      output: {
        artifact: {
          contract: { id: "fixture.complete-report", version: 1 },
          id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
        record: {
          contract: { id: "fixture.review-aggregate", version: 1 },
          key: `operations/${started.operationId}`,
        },
        summary: { errors: 0, warnings: 0 },
      },
      type: "operation_completed",
    });
    if (terminal?.type !== "operation_completed") {
      throw new Error("The literal conformance operation did not complete.");
    }
    const artifactId = (terminal.output as { readonly artifact: { readonly id: string } }).artifact
      .id;
    const artifact = await artifactStore.read(artifactId);
    expect(JSON.parse(new TextDecoder().decode(artifact))).toEqual({
      command: "check",
      diagnostics: [],
      summary: { errors: 0, warnings: 0 },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

async function expectRecordCapabilityFailure(
  prefix: string,
  idempotencyKey: string,
  writePackage: (packageRoot: string) => Promise<void>,
  error: { readonly code: string; readonly message: string },
): Promise<void> {
  const testRoot = await mkdtemp(join(tmpdir(), prefix));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  try {
    await mkdir(workspaceRoot);
    await writePackage(packageRoot);
    const host = createExtensionHost({
      capabilities: [{ id: "adam.storage.records@1", version: "1.0.0" }],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [{ id: "adam.storage.records@1", version: "^1.0.0" }],
          packageName: "@fixture/artifact-extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: createInMemoryOperationStore(),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();
    const started = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey,
      input: null,
    });
    await expect(collectOperationEvents(host, started.operationId)).resolves.toMatchObject([
      { event: { type: "operation_started" } },
      { event: { error, type: "operation_failed" } },
    ]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
}

async function expectCaughtArtifactLimitFailure(
  prefix: string,
  idempotencyKey: string,
  writePackage: (packageRoot: string) => Promise<void>,
): Promise<void> {
  const testRoot = await mkdtemp(join(tmpdir(), prefix));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const artifactStore = await createFileArtifactStore({ root: join(testRoot, "artifacts") });

  try {
    await mkdir(workspaceRoot);
    await writePackage(packageRoot);
    const host = createExtensionHost({
      artifactStore,
      capabilities: [{ id: "adam.artifact.publish@1", version: "1.0.0" }],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [{ id: "adam.artifact.publish@1", version: "^1.0.0" }],
          packageName: "@fixture/artifact-extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: createInMemoryOperationStore(),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();
    const started = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey,
      input: null,
    });

    const events = await collectOperationEvents(host, started.operationId);
    expect(events[0]).toMatchObject({ event: { type: "operation_started" } });
    expect(
      events.slice(1, -1).every((record) => record.event.type === "operation_artifact_published"),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({
      event: {
        error: {
          code: "operation_capability_limit_exceeded",
          message: "The operation exceeded an artifact capability limit.",
        },
        type: "operation_failed",
      },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
}

async function collectOperationEvents(
  host: ReturnType<typeof createExtensionHost>,
  operationId: string,
) {
  const records = [];
  for await (const record of host.operations.events({ operationId })) {
    records.push(record);
  }
  return records;
}

async function writeArtifactExtension(packageRoot: string, controlKey: string): Promise<void> {
  await writeCapabilityExtensionPackage(
    packageRoot,
    "adam.artifact.publish@1",
    `const artifact = await operation.capabilities["adam.artifact.publish@1"].publish({
        bytes: new TextEncoder().encode("review-result"),
        contract: { id: "fixture.review-result", version: 1 },
        mediaType: "application/json",
      });
      const control = globalThis[${JSON.stringify(controlKey)}];
      control.reportPublished(artifact);
      await control.release;
      return { artifact };`,
  );
}

async function writeArtifactLimitExtension(packageRoot: string): Promise<void> {
  await writeCapabilityExtensionPackage(
    packageRoot,
    "adam.artifact.publish@1",
    `try {
        await operation.capabilities["adam.artifact.publish@1"].publish({
          bytes: new Uint8Array(${8 * 1024 * 1024 + 1}),
          contract: { id: "fixture.review-result", version: 1 },
          mediaType: "application/json",
        });
      } catch {}
      return { caught: true };`,
  );
}

async function writeArtifactThenFailExtension(packageRoot: string): Promise<void> {
  await writeCapabilityExtensionPackage(
    packageRoot,
    "adam.artifact.publish@1",
    `await operation.capabilities["adam.artifact.publish@1"].publish({
        bytes: new TextEncoder().encode("review-result"),
        contract: { id: "fixture.review-result", version: 1 },
        mediaType: "application/json",
      });
      throw new Error("fixture failure");`,
  );
}

async function writeArtifactCountExtension(packageRoot: string): Promise<void> {
  await writeCapabilityExtensionPackage(
    packageRoot,
    "adam.artifact.publish@1",
    `for (let index = 0; index < 9; index += 1) {
        try {
          await operation.capabilities["adam.artifact.publish@1"].publish({
            bytes: new TextEncoder().encode(String(index)),
            contract: { id: "fixture.review-result", version: 1 },
            mediaType: "application/json",
          });
        } catch {}
      }
      return { caught: true };`,
  );
}

async function writeArtifactAggregateLimitExtension(packageRoot: string): Promise<void> {
  await writeCapabilityExtensionPackage(
    packageRoot,
    "adam.artifact.publish@1",
    `for (const byteLength of [${8 * 1024 * 1024}, ${8 * 1024 * 1024}, 1]) {
        try {
          await operation.capabilities["adam.artifact.publish@1"].publish({
            bytes: new Uint8Array(byteLength),
            contract: { id: "fixture.review-result", version: 1 },
            mediaType: "application/octet-stream",
          });
        } catch {}
      }
      return { caught: true };`,
  );
}

async function writeCaughtArtifactPublishExtension(packageRoot: string): Promise<void> {
  await writeCapabilityExtensionPackage(
    packageRoot,
    "adam.artifact.publish@1",
    `try {
        await operation.capabilities["adam.artifact.publish@1"].publish({
          bytes: new TextEncoder().encode("review-result"),
          contract: { id: "fixture.review-result", version: 1 },
          mediaType: "application/json",
        });
      } catch {}
      return { caught: true };`,
  );
}

async function writeCancelledArtifactExtension(
  packageRoot: string,
  controlKey: string,
): Promise<void> {
  await writeCapabilityExtensionPackage(
    packageRoot,
    "adam.artifact.publish@1",
    `const control = globalThis[${JSON.stringify(controlKey)}];
      try {
        await operation.capabilities["adam.artifact.publish@1"].publish({
          bytes: new TextEncoder().encode("review-result"),
          contract: { id: "fixture.review-result", version: 1 },
          mediaType: "application/json",
        });
        control.settled("resolved");
      } catch {
        control.settled("rejected");
      }
      return { caught: true };`,
  );
}

async function writeRecordExtension(packageRoot: string): Promise<void> {
  await writeCapabilityExtensionPackage(
    packageRoot,
    "adam.storage.records@1",
    `const records = operation.capabilities["adam.storage.records@1"];
      const created = await records.create({
        key: \`operations/\${operation.operationId}\`,
        contract: { id: "fixture.review-record", version: 1 },
        value: { outcome: "clean" },
      });
      const found = await records.get(created.key);
      const listed = await records.list({ prefix: "operations/", limit: 10 });
      return { created, found, listed };`,
  );
}

async function writeRecordConflictExtension(packageRoot: string): Promise<void> {
  await writeCapabilityExtensionPackage(
    packageRoot,
    "adam.storage.records@1",
    `const records = operation.capabilities["adam.storage.records@1"];
      const input = {
        key: \`operations/\${operation.operationId}\`,
        contract: { id: "fixture.review-record", version: 1 },
        value: { outcome: "clean" },
      };
      await records.create(input);
      try { await records.create(input); } catch {}
      return { caught: true };`,
  );
}

async function writeDeferredRecordExtension(
  packageRoot: string,
  controlKey: string,
): Promise<void> {
  await writeCapabilityExtensionPackage(
    packageRoot,
    "adam.storage.records@1",
    `const records = operation.capabilities["adam.storage.records@1"];
      if (_input.mode === "seed") {
        await records.create({
          key: "records/shared",
          contract: { id: "fixture.review-record", version: 1 },
          value: { outcome: "seeded" },
        });
        return { seeded: true };
      }
      if (_input.mode === "verify") {
        return { found: await records.get("records/shared") };
      }
      const control = globalThis[${JSON.stringify(controlKey)}];
      control.started();
      try {
        if (_input.mode === "create") {
          await records.create({
            key: "records/shared",
            contract: { id: "fixture.review-record", version: 1 },
            value: { outcome: "created" },
          });
        } else if (_input.mode === "get") {
          await records.get("records/shared");
        } else {
          await records.list({ prefix: "records/", limit: 1 });
        }
        control.settled("resolved");
      } catch {
        control.settled("rejected");
      }
      return { caught: true };`,
  );
}

async function writeRecordPaginationExtension(packageRoot: string): Promise<void> {
  await writeCapabilityExtensionPackage(
    packageRoot,
    "adam.storage.records@1",
    `const records = operation.capabilities["adam.storage.records@1"];
      for (const key of ["records/z", "records/A", "records/a", "records/Z"]) {
        await records.create({
          key,
          contract: { id: "fixture.review-record", version: 1 },
          value: { key },
        });
      }
      const keys = [];
      let cursor;
      do {
        const page = await records.list({
          ...(cursor === undefined ? {} : { cursor }),
          prefix: "records/",
          limit: 1,
        });
        keys.push(...page.records.map((record) => record.key));
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return { keys };`,
  );
}

async function writeInvalidRecordKeyExtension(packageRoot: string): Promise<void> {
  await writeCapabilityExtensionPackage(
    packageRoot,
    "adam.storage.records@1",
    `const records = operation.capabilities["adam.storage.records@1"];
      try {
        await records.create({
          key: "../escape",
          contract: { id: "fixture.review-record", version: 1 },
          value: { outcome: "clean" },
        });
      } catch {}
      return { caught: true };`,
  );
}

async function writeOversizedRecordExtension(packageRoot: string): Promise<void> {
  await writeCapabilityExtensionPackage(
    packageRoot,
    "adam.storage.records@1",
    `const records = operation.capabilities["adam.storage.records@1"];
      try {
        await records.create({
          key: \`operations/\${operation.operationId}\`,
          contract: { id: "fixture.review-record", version: 1 },
          value: "x".repeat(6000000),
        });
      } catch {}
      return { caught: true };`,
  );
}

async function writeRecordCountLimitExtension(packageRoot: string): Promise<void> {
  await writeCapabilityExtensionPackage(
    packageRoot,
    "adam.storage.records@1",
    `const records = operation.capabilities["adam.storage.records@1"];
      for (let index = 0; index < 17; index += 1) {
        try {
          await records.create({
            key: \`operations/\${operation.operationId}/\${index}\`,
            contract: { id: "fixture.review-record", version: 1 },
            value: index,
          });
        } catch {}
      }
      return { caught: true };`,
  );
}

async function writeRecordAggregateLimitExtension(packageRoot: string): Promise<void> {
  await writeCapabilityExtensionPackage(
    packageRoot,
    "adam.storage.records@1",
    `const records = operation.capabilities["adam.storage.records@1"];
      for (let index = 0; index < 3; index += 1) {
        try {
          await records.create({
            key: \`operations/\${operation.operationId}/\${index}\`,
            contract: { id: "fixture.review-record", version: 1 },
            value: "x".repeat(3000000),
          });
        } catch {}
      }
      return { caught: true };`,
  );
}

async function writeBiomeExtension(packageRoot: string): Promise<void> {
  await writeCapabilityExtensionPackage(
    packageRoot,
    "adam.analyzer-execution.biome@1",
    `const biome = operation.capabilities["adam.analyzer-execution.biome@1"];
      const analysis = await biome.analyze({
        profile: "adam-biome-recommended-v1",
        files: [
          { path: "src/good.ts", content: "const answer = 42;\\n" },
          { path: "src/bad.ts", content: "if (answer == '42') {}\\n" },
        ],
      });
      return { analysis };`,
  );
}

async function writeNoisyBiomeExtension(packageRoot: string): Promise<void> {
  await writeCapabilityExtensionPackage(
    packageRoot,
    "adam.analyzer-execution.biome@1",
    `const biome = operation.capabilities["adam.analyzer-execution.biome@1"];
      const content = Array.from(
        { length: 3000 },
        (_, index) => \`export const value\${index} = candidate == \${index};\`,
      ).join("\\n");
      const analysis = await biome.analyze({
        profile: "adam-biome-recommended-v1",
        files: [{ path: "src/" + "n".repeat(120) + ".ts", content }],
      });
      return { analysis };`,
  );
}

async function writeLongRunningBiomeExtension(packageRoot: string): Promise<void> {
  await writeCapabilityExtensionPackage(
    packageRoot,
    "adam.analyzer-execution.biome@1",
    `const biome = operation.capabilities["adam.analyzer-execution.biome@1"];
      const files = Array.from({ length: 5 }, (_, fileIndex) => ({
        path: \`src/input-\${fileIndex}.ts\`,
        content: Array.from(
          { length: 15000 },
          (_, lineIndex) => \`export const value\${fileIndex}_\${lineIndex} = \${lineIndex};\`,
        ).join("\\n"),
      }));
      const analysis = await biome.analyze({
        profile: "adam-biome-recommended-v1",
        files,
      });
      return { analysis };`,
  );
}

async function writeConformanceExtension(packageRoot: string): Promise<void> {
  await writeCapabilityExtensionPackage(
    packageRoot,
    ["adam.analyzer-execution.biome@1", "adam.artifact.publish@1", "adam.storage.records@1"],
    `const analysis = await operation.capabilities["adam.analyzer-execution.biome@1"].analyze({
        profile: "adam-biome-recommended-v1",
        files: [{ path: "src/input.ts", content: "export const answer = 42;\\n" }],
      });
      const artifact = await operation.capabilities["adam.artifact.publish@1"].publish({
        bytes: new TextEncoder().encode(JSON.stringify(analysis.report)),
        contract: { id: "fixture.complete-report", version: 1 },
        mediaType: "application/json",
      });
      const record = await operation.capabilities["adam.storage.records@1"].create({
        key: \`operations/\${operation.operationId}\`,
        contract: { id: "fixture.review-aggregate", version: 1 },
        value: { artifact, summary: analysis.report.summary },
      });
      return { artifact, record, summary: analysis.report.summary };`,
  );
}

async function writeCapabilityExtensionPackage(
  packageRoot: string,
  capabilityIds: string | readonly string[],
  executeSource: string,
): Promise<void> {
  const required = (typeof capabilityIds === "string" ? [capabilityIds] : capabilityIds).map(
    (id) => ({ id, version: "^1.0.0" }),
  );
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/artifact-extension",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.extension",
        apiVersion: "^0.2.0",
        runtime: { entry: "./runtime.js" },
        capabilities: {
          required,
          optional: [],
        },
        contributions: [
          {
            kind: "operation",
            id: "fixture.review",
            input: { id: "fixture.input", version: 1 },
            output: { id: "fixture.output", version: 1 },
            progress: { id: "fixture.progress", version: 1 },
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
    async execute(_input, operation) {
      ${executeSource}
    },
  });
}
`,
    "utf8",
  );
}

async function listBiomeTemporaryRoots(): Promise<string[]> {
  return (await readdir(tmpdir()))
    .filter((entry) => entry.startsWith("adam-agent-biome-"))
    .map((entry) => join(tmpdir(), entry));
}

async function findChildWithWorkingDirectory(expected: string): Promise<number | undefined> {
  let children: string;
  try {
    children = await readFile(`/proc/${process.pid}/task/${process.pid}/children`, "utf8");
  } catch {
    return undefined;
  }
  for (const value of children.trim().split(/\s+/u)) {
    if (value.length === 0) {
      continue;
    }
    const pid = Number(value);
    try {
      if ((await readlink(`/proc/${pid}/cwd`)) === expected) {
        return pid;
      }
    } catch {
      // The process may settle between reading the child list and its cwd.
    }
  }
  return undefined;
}

async function waitForValue<T>(read: () => Promise<T | undefined>, message: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(message);
}
