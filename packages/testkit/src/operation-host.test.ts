import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createExtensionHost,
  createFileArtifactStore,
  createInMemoryOperationStore,
  createJsonlOperationStore,
  type OperationOrigin,
  type OperationOriginAuthority,
  type OperationStore,
} from "@adam-agent/agent";
import { expect, test, vi } from "vitest";

const acceptingOperationOriginAuthority: OperationOriginAuthority = Object.freeze({
  validateBoundary: async () => true,
});
const reviewInvocation = Object.freeze({
  id: "review",
  kind: "presentation_command",
  version: 1,
} as const);

test("ExtensionHost starts one unlinked durable operation and ignores hidden origin input", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-host-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const stateRoot = join(testRoot, "state");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(packageRoot);
    const store = createInMemoryOperationStore();
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: store,
      projectRoot: workspaceRoot,
      stateRoot,
    });
    await host.loadConfiguredExtensions();

    const first = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "review-request-1",
      input: { revision: "abc123" },
      origin: {
        invocation: reviewInvocation,
        sessionId: "123e4567-e89b-42d3-a456-426614174091",
        sourceSequence: 1,
      },
    } as Parameters<typeof host.operations.start>[0]);
    const second = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "review-request-1",
      input: { revision: "abc123" },
    });
    const records = [];
    for await (const record of host.operations.events({ operationId: first.operationId })) {
      records.push(record);
    }

    expect(first.operationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(second.operationId).toBe(first.operationId);
    expect(records[0]).toMatchObject({ schemaVersion: 2 });
    expect(records[0]).not.toHaveProperty("origin");
    expect(records.map((record) => record.event)).toEqual([
      {
        type: "operation_started",
        contributionId: "fixture.review",
        deadlineAt: expect.any(String),
        definitionDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        extensionId: "fixture.extension",
        extensionVersion: "1.0.0",
        idempotencyKey: "review-request-1",
        input: { revision: "abc123" },
        inputDigest: "sha256:2a55e3c07660886834b043483337c2143e50ea57313aa7e16b746cca55422ade",
        projectId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
      {
        type: "operation_completed",
        output: { accepted: true, revision: "abc123" },
      },
    ]);
    await expect(host.operations.query(first.operationId)).resolves.toMatchObject({
      operationId: first.operationId,
      origin: null,
      status: "completed",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost rejects a linked start when its durable session boundary is not authoritative", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-linked-authority-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const store = createInMemoryOperationStore();
  const origin = {
    invocation: reviewInvocation,
    sessionId: "123e4567-e89b-42d3-a456-426614174096",
    sourceSequence: 4,
  };
  let observedProjectId: string | undefined;

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(packageRoot);
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationOriginAuthority: {
        async validateBoundary(input) {
          observedProjectId = input.projectId;
          return false;
        },
      },
      operationStore: store,
      projectRoot: workspaceRoot,
    });
    await host.loadConfiguredExtensions();

    await expect(
      host.operations.startLinked({
        contributionId: "fixture.review",
        idempotencyKey: "linked-origin-validation-1",
        input: { revision: "abc123" },
        origin: {
          invocation: { id: "other", kind: "presentation_command", version: 1 },
          sessionId: "123e4567-e89b-42d3-a456-426614174111",
          sourceSequence: 1,
        } as unknown as OperationOrigin,
      }),
    ).rejects.toMatchObject({ code: "operation_origin_invalid", name: "OperationHostError" });
    await expect(
      host.operations.startLinked({
        contributionId: "fixture.review",
        idempotencyKey: "linked-authority-1",
        input: { revision: "abc123" },
        origin,
      }),
    ).rejects.toMatchObject({ code: "operation_origin_invalid", name: "OperationHostError" });
    expect(observedProjectId).toMatch(/^sha256:[0-9a-f]{64}$/u);
    await expect(
      store.listLinkedStarts({
        limit: 1,
        sessionId: origin.sessionId,
        throughSequence: origin.sourceSequence,
      }),
    ).resolves.toEqual([]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost persists the exact session command origin before a linked operation executes", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-linked-start-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(packageRoot);
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationOriginAuthority: acceptingOperationOriginAuthority,
      operationStore: createInMemoryOperationStore(),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();

    const origin = {
      invocation: reviewInvocation,
      sessionId: "123e4567-e89b-42d3-a456-426614174101",
      sourceSequence: 7,
    } as const;
    const reference = await host.operations.startLinked({
      contributionId: "fixture.review",
      idempotencyKey: "linked-review-request-1",
      input: { revision: "abc123" },
      origin,
    });
    const records = [];
    for await (const record of host.operations.events({ operationId: reference.operationId })) {
      records.push(record);
    }

    expect(records[0]).toMatchObject({
      origin,
      schemaVersion: 3,
      sequence: 1,
      event: {
        type: "operation_started",
      },
    });
    await expect(host.operations.query(reference.operationId)).resolves.toMatchObject({ origin });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost never executes a linked operation whose v3 start is not durable", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-linked-persistence-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const controlKey = `__adamLinkedStartPersistence${Date.now()}${Math.random()}`;
  const control = { executeCalls: 0 };
  (globalThis as Record<string, unknown>)[controlKey] = control;
  const durableStore = createInMemoryOperationStore();
  const rejectingStore: OperationStore = {
    append(record) {
      if (record.event.type === "operation_started") {
        return Promise.reject(new Error("injected linked-start persistence failure"));
      }
      return durableStore.append(record);
    },
    findByIdempotency: (scope) => durableStore.findByIdempotency(scope),
    listLinkedStarts: (options) => durableStore.listLinkedStarts(options),
    read: (operationId) => durableStore.read(operationId),
  };
  const origin = {
    invocation: reviewInvocation,
    sessionId: "123e4567-e89b-42d3-a456-426614174105",
    sourceSequence: 3,
  } as const;

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(
      packageRoot,
      `globalThis[${JSON.stringify(controlKey)}].executeCalls += 1;
      return { accepted: true, revision: input.revision };`,
    );
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationOriginAuthority: acceptingOperationOriginAuthority,
      operationStore: rejectingStore,
      projectRoot: workspaceRoot,
    });
    await host.loadConfiguredExtensions();

    await expect(
      host.operations.startLinked({
        contributionId: "fixture.review",
        idempotencyKey: "linked-persistence-1",
        input: { revision: "abc123" },
        origin,
      }),
    ).rejects.toMatchObject({ code: "operation_persistence_failed", name: "OperationHostError" });
    expect(control.executeCalls).toBe(0);
    await expect(
      durableStore.listLinkedStarts({
        limit: 1,
        sessionId: origin.sessionId,
        throughSequence: origin.sourceSequence,
      }),
    ).resolves.toEqual([]);
  } finally {
    delete (globalThis as Record<string, unknown>)[controlKey];
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost rejects an invalid linked origin before reserving its idempotency key", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-linked-origin-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(packageRoot);
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationOriginAuthority: acceptingOperationOriginAuthority,
      operationStore: createInMemoryOperationStore(),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();

    await expect(
      host.operations.startLinked({
        contributionId: "fixture.review",
        idempotencyKey: "linked-origin-validation-1",
        input: { revision: "abc123" },
        origin: {
          invocation: reviewInvocation,
          sessionId: "123e4567-e89b-42d3-a456-426614174111",
          sourceSequence: 0,
        },
      }),
    ).rejects.toMatchObject({ code: "operation_origin_invalid", name: "OperationHostError" });
    await expect(
      host.operations.startLinked({
        contributionId: "fixture.review",
        idempotencyKey: "linked-origin-validation-1",
        input: { revision: "abc123" },
        origin: {
          invocation: reviewInvocation,
          sessionId: "123e4567-e89b-42d3-a456-426614174111",
          sourceSequence: 1,
        },
      }),
    ).resolves.toMatchObject({ operationId: expect.any(String) });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost reuses an exact linked start and rejects a different origin", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-linked-idempotency-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(packageRoot);
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationOriginAuthority: acceptingOperationOriginAuthority,
      operationStore: createInMemoryOperationStore(),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();

    const origin = {
      invocation: reviewInvocation,
      sessionId: "123e4567-e89b-42d3-a456-426614174121",
      sourceSequence: 9,
    };
    const first = await host.operations.startLinked({
      contributionId: "fixture.review",
      idempotencyKey: "linked-idempotency-1",
      input: { revision: "abc123" },
      origin,
    });
    await expect(
      host.operations.startLinked({
        contributionId: "fixture.review",
        idempotencyKey: "linked-idempotency-1",
        input: { revision: "abc123" },
        origin,
      }),
    ).resolves.toEqual(first);
    await expect(
      host.operations.startLinked({
        contributionId: "fixture.review",
        idempotencyKey: "linked-idempotency-1",
        input: { revision: "abc123" },
        origin: {
          ...origin,
          sessionId: "123e4567-e89b-42d3-a456-426614174122",
        },
      }),
    ).rejects.toMatchObject({ code: "operation_idempotency_conflict" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost rejects a linked idempotency key after its operation definition changes", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-linked-definition-"));
  const workspaceRoot = join(testRoot, "workspace");
  const firstPackageRoot = join(testRoot, "extension-a");
  const secondPackageRoot = join(testRoot, "extension-b");
  const store = createInMemoryOperationStore();
  const configuredExtension = (packageRoot: string) => ({
    enabled: true,
    extensionId: "fixture.extension",
    grants: [],
    packageName: "@fixture/extension",
    packageRoot,
    packageVersion: "1.0.0",
  });
  const origin = {
    invocation: reviewInvocation,
    sessionId: "123e4567-e89b-42d3-a456-426614174126",
    sourceSequence: 2,
  };

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(firstPackageRoot);
    await writeOperationExtension(secondPackageRoot);
    const firstHost = createExtensionHost({
      capabilities: [],
      extensions: [configuredExtension(firstPackageRoot)],
      operationOriginAuthority: acceptingOperationOriginAuthority,
      operationStore: store,
      projectRoot: workspaceRoot,
    });
    await firstHost.loadConfiguredExtensions();
    const first = await firstHost.operations.startLinked({
      contributionId: "fixture.review",
      idempotencyKey: "linked-definition-1",
      input: { revision: "abc123" },
      origin,
    });
    for await (const _record of firstHost.operations.events({ operationId: first.operationId })) {
      // The durable terminal event and owner release are the synchronization point.
    }

    const secondHost = createExtensionHost({
      capabilities: [],
      extensions: [configuredExtension(secondPackageRoot)],
      operationOriginAuthority: acceptingOperationOriginAuthority,
      operationStore: store,
      projectRoot: workspaceRoot,
    });
    await secondHost.loadConfiguredExtensions();
    await expect(
      secondHost.operations.startLinked({
        contributionId: "fixture.review",
        idempotencyKey: "linked-definition-1",
        input: { revision: "abc123" },
        origin,
      }),
    ).rejects.toMatchObject({ code: "operation_idempotency_conflict" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost lists only linked operations inside an exact session prefix", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-linked-list-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(packageRoot);
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationOriginAuthority: acceptingOperationOriginAuthority,
      operationStore: createInMemoryOperationStore(),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();

    const sessionId = "123e4567-e89b-42d3-a456-426614174130";
    const included = await host.operations.startLinked({
      contributionId: "fixture.review",
      idempotencyKey: "linked-list-included-1",
      input: { revision: "included" },
      origin: {
        invocation: reviewInvocation,
        sessionId,
        sourceSequence: 3,
      },
    });
    const secondIncluded = await host.operations.startLinked({
      contributionId: "fixture.review",
      idempotencyKey: "linked-list-included-2",
      input: { revision: "included-2" },
      origin: {
        invocation: reviewInvocation,
        sessionId,
        sourceSequence: 5,
      },
    });
    await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "linked-list-legacy-1",
      input: { revision: "legacy" },
    });
    const afterPrefix = await host.operations.startLinked({
      contributionId: "fixture.review",
      idempotencyKey: "linked-list-after-prefix-1",
      input: { revision: "later" },
      origin: {
        invocation: reviewInvocation,
        sessionId,
        sourceSequence: 8,
      },
    });
    await host.operations.startLinked({
      contributionId: "fixture.review",
      idempotencyKey: "linked-list-other-session-1",
      input: { revision: "other" },
      origin: {
        invocation: reviewInvocation,
        sessionId: "123e4567-e89b-42d3-a456-426614174134",
        sourceSequence: 2,
      },
    });

    await expect(host.operations.listLinked({ sessionId, throughSequence: 7 })).resolves.toEqual({
      items: [included, secondIncluded],
      nextCursor: null,
    });
    const firstPage = await host.operations.listLinked({
      limit: 1,
      sessionId,
      throughSequence: 7,
    });
    expect(firstPage).toEqual({ items: [included], nextCursor: included.operationId });
    if (firstPage.nextCursor === null) {
      throw new Error("Expected a linked-operation pagination cursor.");
    }
    await expect(
      host.operations.listLinked({
        cursor: firstPage.nextCursor,
        limit: 1,
        sessionId,
        throughSequence: 7,
      }),
    ).resolves.toEqual({ items: [secondIncluded], nextCursor: null });
    await expect(
      host.operations.listLinked({
        cursor: afterPrefix.operationId,
        sessionId,
        throughSequence: 7,
      }),
    ).rejects.toMatchObject({ code: "operation_list_invalid", name: "OperationHostError" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost canonicalizes input for idempotency and rejects changed input", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-idempotency-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(packageRoot);
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: createInMemoryOperationStore(),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();

    const first = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "canonical-input-1",
      input: { base: "abc123", options: { format: true, lint: false } },
    });
    const reordered = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "canonical-input-1",
      input: { options: { lint: false, format: true }, base: "abc123" },
    });

    expect(reordered.operationId).toBe(first.operationId);
    await expect(
      host.operations.start({
        contributionId: "fixture.review",
        idempotencyKey: "canonical-input-1",
        input: { base: "changed", options: { format: true, lint: false } },
      }),
    ).rejects.toMatchObject({
      code: "operation_idempotency_conflict",
      name: "OperationHostError",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost resolves an existing idempotency key before decoding input again", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-idempotency-decode-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const controlKey = `__adamOperationDecode${Date.now()}${Math.random()}`;
  (globalThis as Record<string, unknown>)[controlKey] = { calls: 0 };

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(
      packageRoot,
      undefined,
      `const control = globalThis[${JSON.stringify(controlKey)}];
      control.calls += 1;
      return control.calls === 1
        ? { ok: true, value }
        : { ok: false, issues: [{ code: "decode_called_again" }] };`,
    );
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: createInMemoryOperationStore(),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();

    const first = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "decode-once-1",
      input: { revision: "original" },
    });
    await expect(
      host.operations.start({
        contributionId: "fixture.review",
        idempotencyKey: "decode-once-1",
        input: { revision: "original" },
      }),
    ).resolves.toEqual(first);
    await expect(
      host.operations.start({
        contributionId: "fixture.review",
        idempotencyKey: "decode-once-1",
        input: { revision: "changed" },
      }),
    ).rejects.toMatchObject({ code: "operation_idempotency_conflict" });
    expect(((globalThis as Record<string, unknown>)[controlKey] as { calls: number }).calls).toBe(
      1,
    );
  } finally {
    delete (globalThis as Record<string, unknown>)[controlKey];
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost rejects domain-invalid input before reserving its idempotency key", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-input-codec-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(
      packageRoot,
      undefined,
      `if (typeof value?.revision !== "string") {
        return { ok: false, issues: [{ code: "revision_required", path: "revision" }] };
      }
      return { ok: true, value };`,
    );
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: createInMemoryOperationStore(),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();

    await expect(
      host.operations.start({
        contributionId: "fixture.review",
        idempotencyKey: "review-input-codec-1",
        input: { revision: 42 },
      }),
    ).rejects.toMatchObject({ code: "operation_input_invalid", name: "OperationHostError" });
    await expect(
      host.operations.start({
        contributionId: "fixture.review",
        idempotencyKey: "review-input-codec-1",
        input: { revision: "valid" },
      }),
    ).resolves.toMatchObject({ operationId: expect.any(String) });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost preserves a successful codec result whose decoded value is undefined", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-undefined-input-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(
      packageRoot,
      "return { accepted: input === undefined };",
      "return { ok: true, value: undefined };",
    );
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
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
      idempotencyKey: "review-undefined-input-1",
      input: { revision: "decoded-away" },
    });

    for await (const _record of host.operations.events({ operationId: started.operationId })) {
      // Draining through the terminal fact is the causal execution boundary.
    }
    await expect(host.operations.query(started.operationId)).resolves.toMatchObject({
      output: { accepted: true },
      status: "completed",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost rejects input above 12,000,000 encoded bytes before durable start", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-input-limit-host-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(packageRoot);
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: createInMemoryOperationStore(),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();

    await expect(
      host.operations.start({
        contributionId: "fixture.review",
        idempotencyKey: "review-input-limit-1",
        input: "x".repeat(12_000_000),
      }),
    ).rejects.toMatchObject({ code: "operation_input_too_large" });
    await expect(
      host.operations.start({
        contributionId: "fixture.review",
        idempotencyKey: "review-input-limit-1",
        input: { revision: "valid-after-rejection" },
      }),
    ).resolves.toMatchObject({ operationId: expect.any(String) });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost contains hostile JSON input access behind a typed validation error", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-hostile-input-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(packageRoot);
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: createInMemoryOperationStore(),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();
    const input = Object.defineProperty({}, "revision", {
      enumerable: true,
      get() {
        throw new Error("untrusted getter");
      },
    });

    await expect(
      host.operations.start({
        contributionId: "fixture.review",
        idempotencyKey: "review-hostile-input-1",
        input,
      }),
    ).rejects.toMatchObject({
      code: "operation_input_invalid",
      name: "OperationHostError",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost persists progress before completed output and exposes the latest value", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-progress-host-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(
      packageRoot,
      `await context.progress({ phase: "analyze", revision: input.revision });
      return { accepted: true, revision: input.revision };`,
    );
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
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
      idempotencyKey: "review-progress-1",
      input: { revision: "def456" },
    });
    const records = [];
    for await (const record of host.operations.events({ operationId: started.operationId })) {
      records.push(record);
    }

    expect(records.map((record) => record.event.type)).toEqual([
      "operation_started",
      "operation_progress",
      "operation_completed",
    ]);
    expect(records[1]?.event).toEqual({
      type: "operation_progress",
      value: { phase: "analyze", revision: "def456" },
    });
    await expect(host.operations.query(started.operationId)).resolves.toMatchObject({
      budget: {
        progressRecordsRemaining: 255,
      },
      progress: { phase: "analyze", revision: "def456" },
      status: "completed",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost cannot complete after a caught progress persistence failure", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-progress-persistence-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(
      packageRoot,
      `try {
        await context.progress({ phase: "persist" });
      } catch {}
      return { accepted: true, revision: input.revision };`,
    );
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: createProgressFailingOperationStore(),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();
    const started = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "review-progress-persistence-1",
      input: { revision: "persistence" },
    });
    const records = [];
    for await (const record of host.operations.events({ operationId: started.operationId })) {
      records.push(record);
    }

    expect(records.map((record) => record.event)).toEqual([
      expect.objectContaining({ type: "operation_started" }),
      {
        type: "operation_failed",
        error: {
          code: "operation_persistence_failed",
          message: "The operation could not persist its progress.",
        },
      },
    ]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost settles a progress persistence failure without waiting for the handler", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-progress-terminal-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(
      packageRoot,
      `try {
        await context.progress({ phase: "persist" });
      } catch {
        await new Promise(() => {});
      }`,
    );
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: createProgressFailingOperationStore(),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();
    const started = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "review-progress-terminal-1",
      input: { revision: "terminal" },
    });
    const records = [];
    for await (const record of host.operations.events({ operationId: started.operationId })) {
      records.push(record);
    }

    expect(records.map((record) => record.event)).toEqual([
      expect.objectContaining({ type: "operation_started" }),
      {
        type: "operation_failed",
        error: {
          code: "operation_persistence_failed",
          message: "The operation could not persist its progress.",
        },
      },
    ]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost reports recovery-required when terminal persistence fails", async () => {
  vi.useFakeTimers();
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-terminal-persistence-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const executeEnteredKey = `__adamOperationTerminalExecute${Date.now()}${Math.random()}`;
  let signalExecuteEntered = (): void => undefined;
  const executeEntered = new Promise<void>((resolve) => {
    signalExecuteEntered = resolve;
  });
  (globalThis as Record<string, unknown>)[executeEnteredKey] = signalExecuteEntered;
  const durableStore = createInMemoryOperationStore();
  const store: OperationStore = {
    append(record) {
      if (record.event.type === "operation_failed") {
        return Promise.reject(new Error("injected terminal persistence failure"));
      }
      return durableStore.append(record);
    },
    findByIdempotency: (scope) => durableStore.findByIdempotency(scope),
    listLinkedStarts: (options) => durableStore.listLinkedStarts(options),
    read: (operationId) => durableStore.read(operationId),
  };

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(
      packageRoot,
      `globalThis[${JSON.stringify(executeEnteredKey)}](); await new Promise(() => {});`,
    );
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: store,
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();
    const started = await host.operations.start({
      contributionId: "fixture.review",
      deadlineMs: 1,
      idempotencyKey: "review-terminal-persistence-1",
      input: { revision: "recovery" },
    });
    await executeEntered;
    await vi.advanceTimersByTimeAsync(1);
    const records = [];
    for await (const record of host.operations.events({ operationId: started.operationId })) {
      records.push(record);
    }

    expect(records.map((record) => record.event.type)).toEqual(["operation_started"]);
    await expect(host.operations.query(started.operationId)).resolves.toMatchObject({
      error: { code: "operation_recovery_required" },
      status: "recovery_required",
    });
  } finally {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>)[executeEnteredKey];
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost recovers completed immutable evidence without rerunning execute", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-reconcile-completed-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  const artifactStore = await createFileArtifactStore({ root: join(stateRoot, "artifacts") });
  const durableStore = await createJsonlOperationStore({ stateRoot, workspaceRoot });
  let rejectOriginalTerminal = true;
  const interruptedStore: OperationStore = {
    append(record) {
      if (rejectOriginalTerminal && record.event.type === "operation_completed") {
        rejectOriginalTerminal = false;
        return Promise.reject(new Error("injected original terminal persistence failure"));
      }
      return durableStore.append(record);
    },
    findByIdempotency: (scope) => durableStore.findByIdempotency(scope),
    listLinkedStarts: (options) => durableStore.listLinkedStarts(options),
    read: (operationId) => durableStore.read(operationId),
  };
  const controlKey = `__adamOperationRecovery${Date.now()}${Math.random()}`;
  const control = { executeCalls: 0, reconcileCalls: 0 };
  (globalThis as Record<string, unknown>)[controlKey] = control;

  try {
    await writeRecoverableOperationExtension(packageRoot, controlKey);
    const configuredExtension = {
      enabled: true,
      extensionId: "fixture.extension",
      grants: [
        { id: "adam.artifact.publish@1", version: "^1.0.0" },
        { id: "adam.storage.records@1", version: "^1.0.0" },
      ],
      packageName: "@fixture/recoverable-extension",
      packageRoot,
      packageVersion: "2.0.0",
    } as const;
    const capabilities = [
      { id: "adam.artifact.publish@1", version: "1.0.0" },
      { id: "adam.storage.records@1", version: "1.0.0" },
    ] as const;
    const firstHost = createExtensionHost({
      artifactStore,
      capabilities,
      extensions: [configuredExtension],
      operationOriginAuthority: acceptingOperationOriginAuthority,
      operationStore: interruptedStore,
      projectRoot: workspaceRoot,
      stateRoot,
    });
    await expect(firstHost.loadConfiguredExtensions()).resolves.toMatchObject({
      extensions: [{ diagnostics: [], extensionId: "fixture.extension", status: "active" }],
    });
    const origin = {
      invocation: reviewInvocation,
      sessionId: "123e4567-e89b-42d3-a456-426614174141",
      sourceSequence: 11,
    };
    const started = await firstHost.operations.startLinked({
      contributionId: "fixture.review",
      idempotencyKey: "review-reconcile-completed-1",
      input: { revision: "recovered" },
      origin,
    });
    for await (const _record of firstHost.operations.events({
      operationId: started.operationId,
    })) {
      // The interrupted durable stream is the synchronization point.
    }
    await expect(firstHost.operations.query(started.operationId)).resolves.toMatchObject({
      error: { code: "operation_recovery_required" },
      status: "recovery_required",
    });

    const reopenedStore = await createJsonlOperationStore({ stateRoot, workspaceRoot });
    const recoveredHost = createExtensionHost({
      artifactStore,
      capabilities,
      extensions: [configuredExtension],
      operationStore: reopenedStore,
      projectRoot: workspaceRoot,
      stateRoot,
    });
    await expect(recoveredHost.loadConfiguredExtensions()).resolves.toMatchObject({
      extensions: [{ diagnostics: [], extensionId: "fixture.extension", status: "active" }],
    });
    const recovered = await recoveredHost.operations.recover(started.operationId);

    expect(recovered).toMatchObject({
      artifacts: [
        {
          contract: { id: "fixture.complete-report", version: 1 },
          id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
      ],
      operationId: started.operationId,
      origin,
      output: { accepted: true, revision: "recovered" },
      status: "completed",
    });
    expect(control).toEqual({ executeCalls: 1, reconcileCalls: 1 });
    expect(
      (await reopenedStore.read(started.operationId)).map((record) => record.event.type),
    ).toEqual([
      "operation_started",
      "operation_artifact_published",
      "operation_reconciliation_started",
      "operation_completed",
    ]);

    rejectOriginalTerminal = true;
    const unresolved = await firstHost.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "review-reconcile-ambiguous-2",
      input: { revision: "missing-terminal" },
    });
    for await (const _record of firstHost.operations.events({
      operationId: unresolved.operationId,
    })) {
      // The second interrupted durable stream is the synchronization point.
    }
    const missingTerminalStore: OperationStore = {
      append(record) {
        if (record.event.type === "operation_completed") {
          return Promise.reject(new Error("injected missing terminal append failure"));
        }
        return durableStore.append(record);
      },
      findByIdempotency: (scope) => durableStore.findByIdempotency(scope),
      listLinkedStarts: (options) => durableStore.listLinkedStarts(options),
      read: (operationId) => durableStore.read(operationId),
    };
    const missingTerminalHost = createExtensionHost({
      artifactStore,
      capabilities,
      extensions: [configuredExtension],
      operationStore: missingTerminalStore,
      projectRoot: workspaceRoot,
      stateRoot,
    });
    await missingTerminalHost.loadConfiguredExtensions();
    await expect(
      missingTerminalHost.operations.recover(unresolved.operationId),
    ).resolves.toMatchObject({ status: "recovery_required" });
    expect(control).toEqual({ executeCalls: 2, reconcileCalls: 2 });
    expect(
      (await durableStore.read(unresolved.operationId)).map((record) => record.event.type),
    ).toEqual([
      "operation_started",
      "operation_artifact_published",
      "operation_reconciliation_started",
    ]);
  } finally {
    delete (globalThis as Record<string, unknown>)[controlKey];
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each([
  {
    expected: {
      error: { code: "extension_execution_failed", message: "Evidence proves failure." },
      status: "failed",
    },
    outcome: "failed",
    terminalType: "operation_failed",
  },
  {
    expected: { message: "Evidence is incomplete.", status: "inspection_required" },
    outcome: "inspection",
    terminalType: "operation_inspection_required",
  },
] as const)("ExtensionHost persists and reuses a reconciled $outcome terminal", async (fixture) => {
  await expectStableReconciliationOutcome(fixture);
});

test("ExtensionHost rejects an invalid declared recovery handler before publication", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-recovery-handler-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeInvalidRecoveryHandlerExtension(packageRoot);
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/invalid-recovery-extension",
          packageRoot,
          packageVersion: "2.0.0",
        },
      ],
      operationStore: createInMemoryOperationStore(),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });

    await expect(host.loadConfiguredExtensions()).resolves.toMatchObject({
      extensions: [
        {
          diagnostics: [{ code: "contribution_handler_invalid", contributionId: "fixture.review" }],
          extensionId: "fixture.extension",
          status: "rejected",
        },
      ],
    });
    expect(host.listContributions()).toEqual([]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each([
  { manifestRecovery: true, registrationRecovery: false },
  { manifestRecovery: false, registrationRecovery: true },
] as const)(
  "ExtensionHost rejects a recovery declaration mismatch before publication",
  async (fixture) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-recovery-declaration-"));
    const workspaceRoot = join(testRoot, "workspace");
    const packageRoot = join(testRoot, "extension");
    try {
      await mkdir(workspaceRoot);
      await writeRecoveryDeclarationMismatchExtension(packageRoot, fixture);
      const host = createExtensionHost({
        capabilities: [],
        extensions: [
          {
            enabled: true,
            extensionId: "fixture.extension",
            grants: [],
            packageName: "@fixture/recovery-declaration-extension",
            packageRoot,
            packageVersion: "2.0.0",
          },
        ],
        operationStore: createInMemoryOperationStore(),
        projectRoot: workspaceRoot,
      });
      await expect(host.loadConfiguredExtensions()).resolves.toMatchObject({
        extensions: [
          {
            diagnostics: [
              { code: "contribution_handler_invalid", contributionId: "fixture.review" },
            ],
            status: "rejected",
          },
        ],
      });
      expect(host.listContributions()).toEqual([]);
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test("ExtensionHost rejects inspection evidence from another operation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-recovery-evidence-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const stateRoot = join(testRoot, "state");
  const controlKey = `__adamOperationRecoveryEvidence${Date.now()}${Math.random()}`;
  const control = { executeCalls: 0, forgeInspectionEvidence: true, reconcileCalls: 0 };
  (globalThis as Record<string, unknown>)[controlKey] = control;

  try {
    await mkdir(workspaceRoot);
    const artifactStore = await createFileArtifactStore({ root: join(stateRoot, "artifacts") });
    const durableStore = createInMemoryOperationStore();
    let rejectOriginalTerminal = true;
    const interruptedStore: OperationStore = {
      append(record) {
        if (rejectOriginalTerminal && record.event.type === "operation_completed") {
          rejectOriginalTerminal = false;
          return Promise.reject(new Error("injected original terminal persistence failure"));
        }
        return durableStore.append(record);
      },
      findByIdempotency: (scope) => durableStore.findByIdempotency(scope),
      listLinkedStarts: (options) => durableStore.listLinkedStarts(options),
      read: (operationId) => durableStore.read(operationId),
    };
    await writeRecoverableOperationExtension(packageRoot, controlKey);
    const configuredExtension = {
      enabled: true,
      extensionId: "fixture.extension",
      grants: [
        { id: "adam.artifact.publish@1", version: "^1.0.0" },
        { id: "adam.storage.records@1", version: "^1.0.0" },
      ],
      packageName: "@fixture/recoverable-extension",
      packageRoot,
      packageVersion: "2.0.0",
    } as const;
    const capabilities = [
      { id: "adam.artifact.publish@1", version: "1.0.0" },
      { id: "adam.storage.records@1", version: "1.0.0" },
    ] as const;
    const firstHost = createExtensionHost({
      artifactStore,
      capabilities,
      extensions: [configuredExtension],
      operationStore: interruptedStore,
      projectRoot: workspaceRoot,
      stateRoot,
    });
    await firstHost.loadConfiguredExtensions();
    const started = await firstHost.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "review-reconcile-evidence-1",
      input: { revision: "forged-evidence" },
    });
    for await (const _record of firstHost.operations.events({
      operationId: started.operationId,
    })) {
      // The interrupted durable stream is the synchronization point.
    }

    const recoveredHost = createExtensionHost({
      artifactStore,
      capabilities,
      extensions: [configuredExtension],
      operationStore: durableStore,
      projectRoot: workspaceRoot,
      stateRoot,
    });
    await recoveredHost.loadConfiguredExtensions();

    await expect(recoveredHost.operations.recover(started.operationId)).rejects.toMatchObject({
      code: "operation_input_invalid",
      name: "OperationHostError",
    });
    expect(control).toMatchObject({ executeCalls: 1, reconcileCalls: 1 });
    expect(
      (await durableStore.read(started.operationId)).map((record) => record.event.type),
    ).toEqual([
      "operation_started",
      "operation_artifact_published",
      "operation_reconciliation_started",
    ]);
  } finally {
    delete (globalThis as Record<string, unknown>)[controlKey];
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost rejects an artifact relabeled from another operation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-recovery-artifact-scope-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const stateRoot = join(testRoot, "state");
  const controlKey = `__adamOperationRecoveryArtifactScope${Date.now()}${Math.random()}`;
  const control: {
    executeCalls: number;
    foreignArtifact?: unknown;
    reconcileCalls: number;
  } = { executeCalls: 0, reconcileCalls: 0 };
  (globalThis as Record<string, unknown>)[controlKey] = control;

  try {
    await mkdir(workspaceRoot);
    const artifactStore = await createFileArtifactStore({ root: join(stateRoot, "artifacts") });
    const durableStore = createInMemoryOperationStore();
    let rejectNextTerminal = false;
    const faultStore: OperationStore = {
      append(record) {
        if (rejectNextTerminal && record.event.type === "operation_completed") {
          rejectNextTerminal = false;
          return Promise.reject(new Error("injected original terminal persistence failure"));
        }
        return durableStore.append(record);
      },
      findByIdempotency: (scope) => durableStore.findByIdempotency(scope),
      listLinkedStarts: (options) => durableStore.listLinkedStarts(options),
      read: (operationId) => durableStore.read(operationId),
    };
    await writeRecoverableOperationExtension(packageRoot, controlKey);
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
          packageName: "@fixture/recoverable-extension",
          packageRoot,
          packageVersion: "2.0.0",
        },
      ],
      operationStore: faultStore,
      projectRoot: workspaceRoot,
      stateRoot,
    });
    await host.loadConfiguredExtensions();
    const first = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "review-artifact-source-1",
      input: { revision: "foreign-source" },
    });
    for await (const _record of host.operations.events({ operationId: first.operationId })) {
      // The first terminal fact is the synchronization point.
    }
    const firstSnapshot = await host.operations.query(first.operationId);
    if (firstSnapshot.status !== "completed" || firstSnapshot.artifacts?.[0] === undefined) {
      throw new Error("Expected the source operation to publish an artifact.");
    }
    control.foreignArtifact = firstSnapshot.artifacts[0];
    rejectNextTerminal = true;
    const second = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "review-artifact-source-2",
      input: { revision: "current-operation" },
    });
    for await (const _record of host.operations.events({ operationId: second.operationId })) {
      // The interrupted durable stream is the synchronization point.
    }

    await expect(host.operations.recover(second.operationId)).rejects.toMatchObject({
      code: "operation_input_invalid",
      name: "OperationHostError",
    });
    expect(control).toMatchObject({ executeCalls: 2, reconcileCalls: 1 });
    expect(
      (await durableStore.read(second.operationId)).some(
        (record) => record.event.type === "operation_completed",
      ),
    ).toBe(false);
  } finally {
    delete (globalThis as Record<string, unknown>)[controlKey];
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost keeps proven completion after a durable cold cancel request", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-recovery-cancel-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const stateRoot = join(testRoot, "state");
  const controlKey = `__adamOperationRecoveryCancel${Date.now()}${Math.random()}`;
  const control = { executeCalls: 0, reconcileCalls: 0 };
  (globalThis as Record<string, unknown>)[controlKey] = control;

  try {
    await mkdir(workspaceRoot);
    const artifactStore = await createFileArtifactStore({ root: join(stateRoot, "artifacts") });
    const durableStore = createInMemoryOperationStore();
    let rejectOriginalTerminal = true;
    const interruptedStore: OperationStore = {
      append(record) {
        if (rejectOriginalTerminal && record.event.type === "operation_completed") {
          rejectOriginalTerminal = false;
          return Promise.reject(new Error("injected original terminal persistence failure"));
        }
        return durableStore.append(record);
      },
      findByIdempotency: (scope) => durableStore.findByIdempotency(scope),
      listLinkedStarts: (options) => durableStore.listLinkedStarts(options),
      read: (operationId) => durableStore.read(operationId),
    };
    await writeRecoverableOperationExtension(packageRoot, controlKey);
    const configuredExtension = {
      enabled: true,
      extensionId: "fixture.extension",
      grants: [
        { id: "adam.artifact.publish@1", version: "^1.0.0" },
        { id: "adam.storage.records@1", version: "^1.0.0" },
      ],
      packageName: "@fixture/recoverable-extension",
      packageRoot,
      packageVersion: "2.0.0",
    } as const;
    const capabilities = [
      { id: "adam.artifact.publish@1", version: "1.0.0" },
      { id: "adam.storage.records@1", version: "1.0.0" },
    ] as const;
    const firstHost = createExtensionHost({
      artifactStore,
      capabilities,
      extensions: [configuredExtension],
      operationStore: interruptedStore,
      projectRoot: workspaceRoot,
      stateRoot,
    });
    await firstHost.loadConfiguredExtensions();
    const started = await firstHost.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "review-reconcile-cancel-1",
      input: { revision: "cancelled-after-effect" },
    });
    for await (const _record of firstHost.operations.events({
      operationId: started.operationId,
    })) {
      // The interrupted durable stream is the synchronization point.
    }

    const recoveredHost = createExtensionHost({
      artifactStore,
      capabilities,
      extensions: [configuredExtension],
      operationStore: durableStore,
      projectRoot: workspaceRoot,
      stateRoot,
    });
    await recoveredHost.loadConfiguredExtensions();
    await expect(recoveredHost.operations.cancel(started.operationId)).resolves.toMatchObject({
      status: "recovery_required",
    });
    await expect(recoveredHost.operations.recover(started.operationId)).resolves.toMatchObject({
      output: { accepted: true, revision: "cancelled-after-effect" },
      status: "completed",
    });

    expect(control).toEqual({ executeCalls: 1, reconcileCalls: 1 });
    expect(
      (await durableStore.read(started.operationId)).map((record) => record.event.type),
    ).toEqual([
      "operation_started",
      "operation_artifact_published",
      "operation_cancel_requested",
      "operation_reconciliation_started",
      "operation_completed",
    ]);
  } finally {
    delete (globalThis as Record<string, unknown>)[controlKey];
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost shares one in-flight reconciliation for duplicate recovery calls", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-recovery-deduplicate-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const stateRoot = join(testRoot, "state");
  const controlKey = `__adamOperationRecoveryDeduplicate${Date.now()}${Math.random()}`;
  const control = { executeCalls: 0, reconcileCalls: 0 };
  (globalThis as Record<string, unknown>)[controlKey] = control;

  try {
    await mkdir(workspaceRoot);
    const artifactStore = await createFileArtifactStore({ root: join(stateRoot, "artifacts") });
    const durableStore = createInMemoryOperationStore();
    let rejectOriginalTerminal = true;
    const interruptedStore: OperationStore = {
      append(record) {
        if (rejectOriginalTerminal && record.event.type === "operation_completed") {
          rejectOriginalTerminal = false;
          return Promise.reject(new Error("injected original terminal persistence failure"));
        }
        return durableStore.append(record);
      },
      findByIdempotency: (scope) => durableStore.findByIdempotency(scope),
      listLinkedStarts: (options) => durableStore.listLinkedStarts(options),
      read: (operationId) => durableStore.read(operationId),
    };
    await writeRecoverableOperationExtension(packageRoot, controlKey);
    const configuredExtension = {
      enabled: true,
      extensionId: "fixture.extension",
      grants: [
        { id: "adam.artifact.publish@1", version: "^1.0.0" },
        { id: "adam.storage.records@1", version: "^1.0.0" },
      ],
      packageName: "@fixture/recoverable-extension",
      packageRoot,
      packageVersion: "2.0.0",
    } as const;
    const capabilities = [
      { id: "adam.artifact.publish@1", version: "1.0.0" },
      { id: "adam.storage.records@1", version: "1.0.0" },
    ] as const;
    const firstHost = createExtensionHost({
      artifactStore,
      capabilities,
      extensions: [configuredExtension],
      operationStore: interruptedStore,
      projectRoot: workspaceRoot,
      stateRoot,
    });
    await firstHost.loadConfiguredExtensions();
    const started = await firstHost.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "review-reconcile-deduplicate-1",
      input: { revision: "deduplicate" },
    });
    for await (const _record of firstHost.operations.events({
      operationId: started.operationId,
    })) {
      // The interrupted durable stream is the synchronization point.
    }

    const recoveredHost = createExtensionHost({
      artifactStore,
      capabilities,
      extensions: [configuredExtension],
      operationStore: durableStore,
      projectRoot: workspaceRoot,
      stateRoot,
    });
    await recoveredHost.loadConfiguredExtensions();
    const [first, second] = await Promise.all([
      recoveredHost.operations.recover(started.operationId),
      recoveredHost.operations.recover(started.operationId),
    ]);

    expect(first).toMatchObject({ status: "completed" });
    expect(second).toEqual(first);
    expect(control).toEqual({ executeCalls: 1, reconcileCalls: 1 });
    expect(
      (await durableStore.read(started.operationId)).map((record) => record.event.type),
    ).toEqual([
      "operation_started",
      "operation_artifact_published",
      "operation_reconciliation_started",
      "operation_completed",
    ]);
  } finally {
    delete (globalThis as Record<string, unknown>)[controlKey];
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost does not reconcile an operation that is still active in the same Host", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-recovery-active-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const stateRoot = join(testRoot, "state");
  const controlKey = `__adamOperationRecoveryActive${Date.now()}${Math.random()}`;
  let signalEvidenceDurable = () => {};
  const evidenceDurable = new Promise<void>((resolve) => {
    signalEvidenceDurable = resolve;
  });
  let releaseExecute = () => {};
  const executeRelease = new Promise<void>((resolve) => {
    releaseExecute = resolve;
  });
  const control = {
    executeCalls: 0,
    onEvidenceDurable: signalEvidenceDurable,
    reconcileCalls: 0,
    releaseExecute: executeRelease,
  };
  (globalThis as Record<string, unknown>)[controlKey] = control;

  try {
    await mkdir(workspaceRoot);
    const artifactStore = await createFileArtifactStore({ root: join(stateRoot, "artifacts") });
    await writeRecoverableOperationExtension(packageRoot, controlKey);
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
          packageName: "@fixture/recoverable-extension",
          packageRoot,
          packageVersion: "2.0.0",
        },
      ],
      operationStore: createInMemoryOperationStore(),
      projectRoot: workspaceRoot,
      stateRoot,
    });
    await host.loadConfiguredExtensions();
    const started = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "review-reconcile-active-1",
      input: { revision: "still-active" },
    });
    await evidenceDurable;

    await expect(host.operations.recover(started.operationId)).resolves.toMatchObject({
      status: "running",
    });
    expect(control).toMatchObject({ executeCalls: 1, reconcileCalls: 0 });

    releaseExecute();
    for await (const _record of host.operations.events({ operationId: started.operationId })) {
      // The real terminal event and owner release are the synchronization point.
    }
  } finally {
    releaseExecute();
    delete (globalThis as Record<string, unknown>)[controlKey];
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost rejects recovery after the exact capability grant changes", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-recovery-grant-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const controlKey = `__adamOperationRecoveryGrant${Date.now()}${Math.random()}`;
  const control = { executeCalls: 0, reconcileCalls: 0 };
  (globalThis as Record<string, unknown>)[controlKey] = control;

  try {
    await mkdir(workspaceRoot);
    await writeGrantSensitiveRecoveryExtension(packageRoot, controlKey);
    const durableStore = createInMemoryOperationStore();
    let rejectOriginalTerminal = true;
    const interruptedStore: OperationStore = {
      append(record) {
        if (rejectOriginalTerminal && record.event.type === "operation_completed") {
          rejectOriginalTerminal = false;
          return Promise.reject(new Error("injected original terminal persistence failure"));
        }
        return durableStore.append(record);
      },
      findByIdempotency: (scope) => durableStore.findByIdempotency(scope),
      listLinkedStarts: (options) => durableStore.listLinkedStarts(options),
      read: (operationId) => durableStore.read(operationId),
    };
    const configuredExtension = (grantVersion: string) => ({
      enabled: true,
      extensionId: "fixture.extension",
      grants: [{ id: "fixture.capability@1", version: grantVersion }],
      packageName: "@fixture/grant-recovery-extension",
      packageRoot,
      packageVersion: "2.0.0",
    });
    const capabilities = [{ id: "fixture.capability@1", version: "1.0.0" }] as const;
    const firstHost = createExtensionHost({
      capabilities,
      extensions: [configuredExtension("^1.0.0")],
      operationStore: interruptedStore,
      projectRoot: workspaceRoot,
    });
    await firstHost.loadConfiguredExtensions();
    const started = await firstHost.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "review-reconcile-grant-1",
      input: { revision: "grant-change" },
    });
    for await (const _record of firstHost.operations.events({
      operationId: started.operationId,
    })) {
      // The interrupted durable stream is the synchronization point.
    }

    const changedHost = createExtensionHost({
      capabilities,
      extensions: [configuredExtension(">=1.0.0 <2.0.0")],
      operationStore: durableStore,
      projectRoot: workspaceRoot,
    });
    await changedHost.loadConfiguredExtensions();

    await expect(changedHost.operations.recover(started.operationId)).rejects.toMatchObject({
      code: "operation_contribution_unavailable",
      name: "OperationHostError",
    });
    expect(control).toEqual({ executeCalls: 1, reconcileCalls: 0 });
    expect(
      (await durableStore.read(started.operationId)).map((record) => record.event.type),
    ).toEqual(["operation_started"]);
  } finally {
    delete (globalThis as Record<string, unknown>)[controlKey];
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each([
  { expectedCode: "operation_input_invalid", mode: "rejectInput", reconcileCalls: 0 },
  { expectedCode: "operation_input_invalid", mode: "rejectOutput", reconcileCalls: 1 },
  { expectedStatus: "recovery_required", mode: "rejectFailure", reconcileCalls: 1 },
] as const)("ExtensionHost fails closed for a recovery $mode mismatch", async (fixture) => {
  await expectRecoveryValidationMismatch(fixture);
});

test.each([
  { expectedCode: "operation_store_project_mismatch", mode: "project" },
  { expectedCode: "operation_contribution_unavailable", mode: "version" },
] as const)(
  "ExtensionHost rejects a recovery $mode identity mismatch before the hook",
  async (fixture) => {
    await expectRecoveryIdentityMismatch(fixture);
  },
);

test("ExtensionHost bounds an uncooperative reconciliation hook", async () => {
  vi.useFakeTimers();
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-recovery-deadline-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const controlKey = `__adamOperationRecoveryDeadline${Date.now()}${Math.random()}`;
  let signalReconcileEntered = (): void => undefined;
  const reconcileEntered = new Promise<void>((resolve) => {
    signalReconcileEntered = resolve;
  });
  const control = {
    executeCalls: 0,
    hangReconcile: true,
    reconcileCalls: 0,
    reconcileEntered: signalReconcileEntered,
  };
  (globalThis as Record<string, unknown>)[controlKey] = control;

  try {
    await mkdir(workspaceRoot);
    await writeGrantSensitiveRecoveryExtension(packageRoot, controlKey);
    const durableStore = createInMemoryOperationStore();
    let rejectOriginalTerminal = true;
    const interruptedStore: OperationStore = {
      append(record) {
        if (rejectOriginalTerminal && record.event.type === "operation_completed") {
          rejectOriginalTerminal = false;
          return Promise.reject(new Error("injected original terminal persistence failure"));
        }
        return durableStore.append(record);
      },
      findByIdempotency: (scope) => durableStore.findByIdempotency(scope),
      listLinkedStarts: (options) => durableStore.listLinkedStarts(options),
      read: (operationId) => durableStore.read(operationId),
    };
    const configuredExtension = {
      enabled: true,
      extensionId: "fixture.extension",
      grants: [{ id: "fixture.capability@1", version: "^1.0.0" }],
      packageName: "@fixture/grant-recovery-extension",
      packageRoot,
      packageVersion: "2.0.0",
    } as const;
    const capabilities = [{ id: "fixture.capability@1", version: "1.0.0" }] as const;
    const firstHost = createExtensionHost({
      capabilities,
      extensions: [configuredExtension],
      operationStore: interruptedStore,
      projectRoot: workspaceRoot,
    });
    await firstHost.loadConfiguredExtensions();
    const started = await firstHost.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "review-reconcile-deadline-1",
      input: { revision: "deadline" },
    });
    for await (const _record of firstHost.operations.events({
      operationId: started.operationId,
    })) {
      // The interrupted durable stream is the synchronization point.
    }
    const recoveredHost = createExtensionHost({
      capabilities,
      extensions: [configuredExtension],
      operationDeadlineMs: 10,
      operationStore: durableStore,
      projectRoot: workspaceRoot,
    });
    await recoveredHost.loadConfiguredExtensions();

    const recovery = recoveredHost.operations.recover(started.operationId);
    const recoveryExpectation = expect(recovery).rejects.toMatchObject({
      code: "operation_reconciliation_failed",
      name: "OperationHostError",
    });
    await reconcileEntered;
    await vi.advanceTimersByTimeAsync(10);
    await recoveryExpectation;
    expect(control).toMatchObject({ executeCalls: 1, reconcileCalls: 1 });
    expect(
      (await durableStore.read(started.operationId)).map((record) => record.event.type),
    ).toEqual(["operation_started", "operation_reconciliation_started"]);
  } finally {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>)[controlKey];
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost rereads a durable recovery terminal after an ambiguous append failure", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-recovery-ambiguous-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const stateRoot = join(testRoot, "state");
  const controlKey = `__adamOperationRecoveryAmbiguous${Date.now()}${Math.random()}`;
  const control = { executeCalls: 0, reconcileCalls: 0 };
  (globalThis as Record<string, unknown>)[controlKey] = control;

  try {
    await mkdir(workspaceRoot);
    const artifactStore = await createFileArtifactStore({ root: join(stateRoot, "artifacts") });
    const durableStore = createInMemoryOperationStore();
    let rejectOriginalTerminal = true;
    const interruptedStore: OperationStore = {
      append(record) {
        if (rejectOriginalTerminal && record.event.type === "operation_completed") {
          rejectOriginalTerminal = false;
          return Promise.reject(new Error("injected original terminal persistence failure"));
        }
        return durableStore.append(record);
      },
      findByIdempotency: (scope) => durableStore.findByIdempotency(scope),
      listLinkedStarts: (options) => durableStore.listLinkedStarts(options),
      read: (operationId) => durableStore.read(operationId),
    };
    await writeRecoverableOperationExtension(packageRoot, controlKey);
    const configuredExtension = {
      enabled: true,
      extensionId: "fixture.extension",
      grants: [
        { id: "adam.artifact.publish@1", version: "^1.0.0" },
        { id: "adam.storage.records@1", version: "^1.0.0" },
      ],
      packageName: "@fixture/recoverable-extension",
      packageRoot,
      packageVersion: "2.0.0",
    } as const;
    const capabilities = [
      { id: "adam.artifact.publish@1", version: "1.0.0" },
      { id: "adam.storage.records@1", version: "1.0.0" },
    ] as const;
    const firstHost = createExtensionHost({
      artifactStore,
      capabilities,
      extensions: [configuredExtension],
      operationStore: interruptedStore,
      projectRoot: workspaceRoot,
      stateRoot,
    });
    await firstHost.loadConfiguredExtensions();
    const started = await firstHost.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "review-reconcile-ambiguous-1",
      input: { revision: "ambiguous-terminal" },
    });
    for await (const _record of firstHost.operations.events({
      operationId: started.operationId,
    })) {
      // The interrupted durable stream is the synchronization point.
    }

    const ambiguousStore: OperationStore = {
      async append(record) {
        await durableStore.append(record);
        if (record.event.type === "operation_completed") {
          throw new Error("injected ambiguous terminal append failure");
        }
      },
      findByIdempotency: (scope) => durableStore.findByIdempotency(scope),
      listLinkedStarts: (options) => durableStore.listLinkedStarts(options),
      read: (operationId) => durableStore.read(operationId),
    };
    const recoveredHost = createExtensionHost({
      artifactStore,
      capabilities,
      extensions: [configuredExtension],
      operationStore: ambiguousStore,
      projectRoot: workspaceRoot,
      stateRoot,
    });
    await recoveredHost.loadConfiguredExtensions();

    await expect(recoveredHost.operations.recover(started.operationId)).resolves.toMatchObject({
      output: { accepted: true, revision: "ambiguous-terminal" },
      status: "completed",
    });
    expect(control).toEqual({ executeCalls: 1, reconcileCalls: 1 });
    expect(
      (await durableStore.read(started.operationId)).map((record) => record.event.type),
    ).toEqual([
      "operation_started",
      "operation_artifact_published",
      "operation_reconciliation_started",
      "operation_completed",
    ]);
  } finally {
    delete (globalThis as Record<string, unknown>)[controlKey];
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost events replay durable records before continuing with live records", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-events-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const controlKey = `__adamOperationEvents${Date.now()}${Math.random()}`;
  let reportDurable = () => {};
  let releaseHandler = () => {};
  const progressDurable = new Promise<void>((resolve) => {
    reportDurable = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  (globalThis as Record<string, unknown>)[controlKey] = { progressDurable: reportDurable, release };

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(
      packageRoot,
      `const control = globalThis[${JSON.stringify(controlKey)}];
      await context.progress({ phase: "durable" });
      control.progressDurable();
      await control.release;
      await context.progress({ phase: "live" });
      return { accepted: true, revision: input.revision };`,
    );
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
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
      idempotencyKey: "review-events-1",
      input: { revision: "events" },
    });
    await progressDurable;
    const iterator = host.operations
      .events({ afterSequence: 1, operationId: started.operationId })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { event: { type: "operation_progress", value: { phase: "durable" } } },
    });
    const liveProgress = iterator.next();
    releaseHandler();
    await expect(liveProgress).resolves.toMatchObject({
      done: false,
      value: { event: { type: "operation_progress", value: { phase: "live" } } },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { event: { type: "operation_completed" } },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  } finally {
    delete (globalThis as Record<string, unknown>)[controlKey];
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost makes a progress-budget violation terminal even when the handler catches it", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-progress-limit-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(
      packageRoot,
      `try {
        await context.progress({ body: "x".repeat(65536) });
      } catch {}
      return { accepted: true, revision: input.revision };`,
    );
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
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
      idempotencyKey: "review-progress-limit-1",
      input: { revision: "budget" },
    });
    const records = [];
    for await (const record of host.operations.events({ operationId: started.operationId })) {
      records.push(record);
    }

    expect(records.at(-1)?.event).toEqual({
      type: "operation_failed",
      error: {
        code: "operation_progress_limit_exceeded",
        message: "The operation exceeded its progress budget.",
      },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost distinguishes invalid progress from a progress-budget violation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-progress-invalid-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(
      packageRoot,
      `try {
        await context.progress(undefined);
      } catch {}
      return { accepted: true, revision: input.revision };`,
    );
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
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
      idempotencyKey: "review-progress-invalid-1",
      input: { revision: "invalid-progress" },
    });
    const records = [];
    for await (const record of host.operations.events({ operationId: started.operationId })) {
      records.push(record);
    }

    expect(records.at(-1)?.event).toEqual({
      type: "operation_failed",
      error: {
        code: "operation_progress_invalid",
        message: "The extension reported invalid operation progress.",
      },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost enforces the aggregate progress count across concurrent reports", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-progress-concurrent-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(
      packageRoot,
      `await Promise.allSettled(
        Array.from({ length: 257 }, (_, index) => context.progress({ index })),
      );
      return { accepted: true, revision: input.revision };`,
    );
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
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
      idempotencyKey: "review-progress-concurrent-1",
      input: { revision: "concurrent" },
    });
    const records = [];
    for await (const record of host.operations.events({ operationId: started.operationId })) {
      records.push(record);
    }

    expect(records.filter((record) => record.event.type === "operation_progress")).toHaveLength(
      256,
    );
    expect(records.at(-1)?.event).toEqual({
      type: "operation_failed",
      error: {
        code: "operation_progress_limit_exceeded",
        message: "The operation exceeded its progress budget.",
      },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost records invalid encoded output as a typed infrastructure failure", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-output-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(packageRoot, "return undefined;");
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
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
      idempotencyKey: "review-output-1",
      input: { revision: "ghi789" },
    });
    const records = [];
    for await (const record of host.operations.events({ operationId: started.operationId })) {
      records.push(record);
    }

    expect(records.at(-1)?.event).toEqual({
      type: "operation_failed",
      error: {
        code: "operation_output_invalid",
        message: "The extension returned invalid operation output.",
      },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost records encoded output above 5,000,000 bytes as invalid", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-output-limit-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(packageRoot, 'return "x".repeat(5_000_000);');
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
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
      idempotencyKey: "review-output-limit-1",
      input: { revision: "output-limit" },
    });
    const records = [];
    for await (const record of host.operations.events({ operationId: started.operationId })) {
      records.push(record);
    }

    expect(records.at(-1)?.event).toEqual({
      type: "operation_failed",
      error: {
        code: "operation_output_invalid",
        message: "The extension returned invalid operation output.",
      },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost keeps a valid domain rejection as a completed operation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-domain-rejection-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(
      packageRoot,
      'return { accepted: false, reason: "policy", revision: input.revision };',
    );
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
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
      idempotencyKey: "review-domain-rejection-1",
      input: { revision: "rejected" },
    });
    const records = [];
    for await (const record of host.operations.events({ operationId: started.operationId })) {
      records.push(record);
    }

    expect(records.at(-1)?.event).toEqual({
      type: "operation_completed",
      output: { accepted: false, reason: "policy", revision: "rejected" },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost reduces a handler exception to a bounded infrastructure failure", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-handler-failure-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(packageRoot, 'throw new Error("private extension detail");');
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
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
      idempotencyKey: "review-handler-failure-1",
      input: { revision: "handler-failure" },
    });
    const records = [];
    for await (const record of host.operations.events({ operationId: started.operationId })) {
      records.push(record);
    }

    expect(records.at(-1)?.event).toEqual({
      type: "operation_failed",
      error: {
        code: "extension_execution_failed",
        message: "The extension operation failed.",
      },
    });
    expect(JSON.stringify(records)).not.toContain("private extension detail");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost persists one idempotent cancel request and one cancelled terminal fact", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-cancel-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(
      packageRoot,
      `if (!context.signal.aborted) {
        await new Promise((resolve) => context.signal.addEventListener("abort", resolve, { once: true }));
      }
      return { accepted: false, revision: input.revision };`,
    );
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
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
      idempotencyKey: "review-cancel-1",
      input: { revision: "jkl012" },
    });

    const firstCancel = await host.operations.cancel(started.operationId);
    const secondCancel = await host.operations.cancel(started.operationId);
    const records = [];
    for await (const record of host.operations.events({ operationId: started.operationId })) {
      records.push(record);
    }

    expect(firstCancel.operationId).toBe(started.operationId);
    expect(secondCancel.operationId).toBe(started.operationId);
    expect(records.map((record) => record.event)).toEqual([
      expect.objectContaining({ type: "operation_started" }),
      { type: "operation_cancel_requested", reason: "caller" },
      { type: "operation_cancelled", reason: "caller" },
    ]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost enforces a caller-tightened deadline as one failed terminal fact", async () => {
  vi.useFakeTimers();
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-deadline-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const executeEnteredKey = `__adamOperationDeadlineExecute${Date.now()}${Math.random()}`;
  let signalExecuteEntered = (): void => undefined;
  const executeEntered = new Promise<void>((resolve) => {
    signalExecuteEntered = resolve;
  });
  (globalThis as Record<string, unknown>)[executeEnteredKey] = signalExecuteEntered;

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(
      packageRoot,
      `globalThis[${JSON.stringify(executeEnteredKey)}]();
      if (!context.signal.aborted) {
        await new Promise((resolve) => context.signal.addEventListener("abort", resolve, { once: true }));
      }
      return { accepted: true, revision: input.revision };`,
    );
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
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
      deadlineMs: 1,
      idempotencyKey: "review-deadline-1",
      input: { revision: "mno345" },
    });
    await executeEntered;
    await vi.advanceTimersByTimeAsync(1);
    const records = [];
    for await (const record of host.operations.events({ operationId: started.operationId })) {
      records.push(record);
    }

    expect(records.at(-1)?.event).toEqual({
      type: "operation_failed",
      error: {
        code: "operation_deadline_exceeded",
        message: "The operation exceeded its deadline.",
      },
    });
  } finally {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>)[executeEnteredKey];
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost applies a bounded host deadline and lets callers only tighten it", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-deadline-policy-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const store = createInMemoryOperationStore();

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(packageRoot);
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationDeadlineMs: 120_000,
      operationStore: store,
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();
    const started = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "review-deadline-policy-1",
      input: { revision: "policy" },
    });
    const startRecord = (await store.read(started.operationId))[0];

    expect(startRecord?.event.type).toBe("operation_started");
    if (startRecord?.event.type !== "operation_started") {
      throw new Error("Expected a durable start record.");
    }
    expect(Date.parse(startRecord.event.deadlineAt) - Date.parse(startRecord.recordedAt)).toBe(
      120_000,
    );
    await expect(
      host.operations.start({
        contributionId: "fixture.review",
        deadlineMs: 120_001,
        idempotencyKey: "review-deadline-policy-2",
        input: { revision: "too-long" },
      }),
    ).rejects.toMatchObject({ code: "operation_deadline_invalid" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost gives each operation an immutable host-owned budget snapshot", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-budget-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(packageRoot, "return context.budget;");
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
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
      idempotencyKey: "review-budget-1",
      input: { revision: "budget" },
    });
    const records = [];
    for await (const record of host.operations.events({ operationId: started.operationId })) {
      records.push(record);
    }

    expect(records.at(-1)?.event).toEqual({
      type: "operation_completed",
      output: {
        inputBytes: 21,
        outputBytesRemaining: 5_000_000,
        progressBytesRemaining: 1_048_576,
        progressRecordsRemaining: 256,
      },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost gives each operation fresh immutable identity and provenance context", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-context-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(
      packageRoot,
      `return {
        diagnostics: context.diagnostics,
        frozen: Object.isFrozen(context) && Object.isFrozen(context.provenance),
        operationId: context.operationId,
        provenance: context.provenance,
      };`,
    );
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
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
      idempotencyKey: "review-context-1",
      input: { revision: "context" },
    });
    const records = [];
    for await (const record of host.operations.events({ operationId: started.operationId })) {
      records.push(record);
    }

    expect(records.at(-1)?.event).toEqual({
      type: "operation_completed",
      output: {
        diagnostics: [],
        frozen: true,
        operationId: started.operationId,
        provenance: {
          contributionId: "fixture.review",
          extensionId: "fixture.extension",
          extensionVersion: "1.0.0",
          projectId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
      },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost reports a reopened nonterminal operation as recovery-required without mutation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-recovery-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const stateRoot = join(testRoot, "state");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(packageRoot, "await new Promise(() => {});");
    const firstStore = await createJsonlOperationStore({ stateRoot, workspaceRoot });
    const deterministicOwner = {
      acquire: async () => ({ release: async () => {} }),
      run: <T>(operation: () => Promise<T>) => operation(),
    };
    const firstHost = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: firstStore,
      projectLifecycleOwner: deterministicOwner,
      projectRoot: workspaceRoot,
      stateRoot,
    });
    await firstHost.loadConfiguredExtensions();
    const started = await firstHost.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "review-recovery-1",
      input: { revision: "pqr678" },
    });

    const reopenedStore = await createJsonlOperationStore({ stateRoot, workspaceRoot });
    const reopenedHost = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: reopenedStore,
      projectLifecycleOwner: deterministicOwner,
      projectRoot: workspaceRoot,
      stateRoot,
    });
    await reopenedHost.loadConfiguredExtensions();
    const before = await reopenedStore.read(started.operationId);
    const snapshot = await reopenedHost.operations.query(started.operationId);
    const repeated = await reopenedHost.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "review-recovery-1",
      input: { revision: "pqr678" },
    });
    const replayed = [];
    for await (const record of reopenedHost.operations.events({
      operationId: started.operationId,
    })) {
      replayed.push(record);
    }

    expect(snapshot).toMatchObject({
      error: { code: "operation_recovery_required" },
      operationId: started.operationId,
      status: "recovery_required",
    });
    expect(repeated.operationId).toBe(started.operationId);
    expect(replayed).toEqual(before);
    expect(await reopenedStore.read(started.operationId)).toEqual(before);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost settles a legacy nonterminal operation as stable inspection-required", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-legacy-inspection-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const stateRoot = join(testRoot, "state");
  const legacyOperationId = "123e4567-e89b-42d3-a456-426614174099";

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(packageRoot);
    const store = await createJsonlOperationStore({ stateRoot, workspaceRoot });
    if (store.projectId === undefined) {
      throw new Error("Expected a project-scoped JSONL OperationStore.");
    }
    await store.append({
      schemaVersion: 1,
      operationId: legacyOperationId,
      sequence: 1,
      recordedAt: "2026-08-17T08:00:00.000Z",
      event: {
        type: "operation_started",
        contributionId: "fixture.review",
        deadlineAt: "2026-08-17T08:01:00.000Z",
        extensionId: "fixture.extension",
        extensionVersion: "1.0.0",
        idempotencyKey: "legacy-recovery-1",
        input: { revision: "legacy" },
        inputDigest: "sha256:f572421550ce5cbc9e541e1ff5ac77350797099b31eb30c56d23134b973902c0",
        projectId: store.projectId,
      },
    });
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: store,
      projectRoot: workspaceRoot,
      stateRoot,
    });
    await host.loadConfiguredExtensions();

    const first = await host.operations.recover(legacyOperationId);
    const beforeRepeat = await store.read(legacyOperationId);
    const repeated = await host.operations.recover(legacyOperationId);

    expect(first).toMatchObject({
      message: "Legacy operation identity cannot be reconciled safely.",
      origin: null,
      status: "inspection_required",
    });
    expect(repeated).toEqual(first);
    expect(await store.read(legacyOperationId)).toEqual(beforeRepeat);
    expect(beforeRepeat.map((record) => record.event.type)).toEqual([
      "operation_started",
      "operation_inspection_required",
    ]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost rejects an OperationStore bound to another canonical project", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-project-scope-"));
  const firstWorkspaceRoot = join(testRoot, "workspace-a");
  const secondWorkspaceRoot = join(testRoot, "workspace-b");
  const packageRoot = join(testRoot, "extension");
  const stateRoot = join(testRoot, "state");

  try {
    await mkdir(firstWorkspaceRoot);
    await mkdir(secondWorkspaceRoot);
    await writeOperationExtension(packageRoot);
    const firstProjectStore = await createJsonlOperationStore({
      stateRoot,
      workspaceRoot: firstWorkspaceRoot,
    });
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationStore: firstProjectStore,
      projectRoot: secondWorkspaceRoot,
      stateRoot,
    });
    await host.loadConfiguredExtensions();

    await expect(
      host.operations.start({
        contributionId: "fixture.review",
        idempotencyKey: "review-wrong-project-1",
        input: { revision: "wrong-project" },
      }),
    ).rejects.toMatchObject({
      code: "operation_store_project_mismatch",
      name: "OperationHostError",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost disables new work but reports a non-settling active operation as pending", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-disable-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const store = createInMemoryOperationStore();

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(packageRoot, "await new Promise(() => {});");
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationDisableGraceMs: 1,
      operationStore: store,
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();
    const started = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "review-disable-1",
      input: { revision: "stu901" },
    });

    const disabled = await host.disableExtension("fixture.extension");

    expect(disabled).toMatchObject({
      extensionId: "fixture.extension",
      status: "disabled_with_pending_operations",
    });
    await expect(host.operations.query(started.operationId)).resolves.toMatchObject({
      status: "cancel_requested",
    });
    await expect(
      host.operations.start({
        contributionId: "fixture.review",
        idempotencyKey: "review-disable-2",
        input: { revision: "vwx234" },
      }),
    ).rejects.toMatchObject({
      code: "operation_contribution_unavailable",
      name: "OperationHostError",
    });
    expect((await store.read(started.operationId)).map((record) => record.event)).toEqual([
      expect.objectContaining({ type: "operation_started" }),
      { type: "operation_cancel_requested", reason: "extension_disabled" },
    ]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost retains a deadline-failed extension while its handler is still running", async () => {
  vi.useFakeTimers();
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-disable-deadline-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const executeEnteredKey = `__adamOperationDisableExecute${Date.now()}${Math.random()}`;
  let signalExecuteEntered = (): void => undefined;
  const executeEntered = new Promise<void>((resolve) => {
    signalExecuteEntered = resolve;
  });
  (globalThis as Record<string, unknown>)[executeEnteredKey] = signalExecuteEntered;

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(
      packageRoot,
      `globalThis[${JSON.stringify(executeEnteredKey)}](); await new Promise(() => {});`,
    );
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationDisableGraceMs: 1,
      operationStore: createInMemoryOperationStore(),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();
    const started = await host.operations.start({
      contributionId: "fixture.review",
      deadlineMs: 1,
      idempotencyKey: "review-disable-deadline-1",
      input: { revision: "deadline-pending" },
    });
    await executeEntered;
    await vi.advanceTimersByTimeAsync(1);
    for await (const _record of host.operations.events({ operationId: started.operationId })) {
      // The durable deadline terminal fact is the synchronization point.
    }

    vi.useRealTimers();
    const disabling = host.disableExtension("fixture.extension");
    await expect(disabling).resolves.toMatchObject({
      extensionId: "fixture.extension",
      status: "disabled_with_pending_operations",
    });
    await expect(host.operations.query(started.operationId)).resolves.toMatchObject({
      error: { code: "operation_deadline_exceeded" },
      status: "failed",
    });
  } finally {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>)[executeEnteredKey];
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ExtensionHost finalizes disable after a previously pending handler settles", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-disable-finalize-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const controlKey = `__adamOperationDisable${Date.now()}${Math.random()}`;
  let releaseHandler = () => {};
  const release = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  (globalThis as Record<string, unknown>)[controlKey] = { release };

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(
      packageRoot,
      `const control = globalThis[${JSON.stringify(controlKey)}];
      await control.release;
      return { accepted: false, revision: input.revision };`,
    );
    const host = createExtensionHost({
      capabilities: [],
      extensions: [
        {
          enabled: true,
          extensionId: "fixture.extension",
          grants: [],
          packageName: "@fixture/extension",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
      operationDisableGraceMs: 1,
      operationStore: createInMemoryOperationStore(),
      projectRoot: workspaceRoot,
      stateRoot: join(testRoot, "state"),
    });
    await host.loadConfiguredExtensions();
    const started = await host.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: "review-disable-finalize-1",
      input: { revision: "finalize" },
    });
    await expect(host.disableExtension("fixture.extension")).resolves.toMatchObject({
      status: "disabled_with_pending_operations",
    });

    releaseHandler();
    for await (const _record of host.operations.events({ operationId: started.operationId })) {
      // Draining through the terminal fact is the synchronization point.
    }

    await expect(host.disableExtension("fixture.extension")).resolves.toMatchObject({
      status: "disabled",
    });
  } finally {
    delete (globalThis as Record<string, unknown>)[controlKey];
    await rm(testRoot, { recursive: true, force: true });
  }
});

function createProgressFailingOperationStore(): OperationStore {
  const durableStore = createInMemoryOperationStore();
  let rejectProgress = true;
  return {
    append(record) {
      if (rejectProgress && record.event.type === "operation_progress") {
        rejectProgress = false;
        return Promise.reject(new Error("injected progress persistence failure"));
      }
      return durableStore.append(record);
    },
    findByIdempotency: (scope) => durableStore.findByIdempotency(scope),
    listLinkedStarts: (options) => durableStore.listLinkedStarts(options),
    read: (operationId) => durableStore.read(operationId),
  };
}

async function writeOperationExtension(
  packageRoot: string,
  executeBody = "return { accepted: true, revision: input.revision };",
  inputDecodeBody = "return { ok: true, value };",
): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/extension",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.extension",
        apiVersion: "^0.3.0",
        runtime: { entry: "./runtime.js" },
        capabilities: { required: [], optional: [] },
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
    decode(value) {
      if (id === "fixture.input") {
        ${inputDecodeBody}
      }
      return { ok: true, value };
    },
    encode(value) { return { ok: true, value }; },
  });
  context.registerOperation({
    id: "fixture.review",
    input: codec("fixture.input"),
    output: codec("fixture.output"),
    progress: codec("fixture.progress"),
    async execute(input, context) {
      ${executeBody}
    },
  });
}
`,
    "utf8",
  );
}

async function writeRecoverableOperationExtension(
  packageRoot: string,
  controlKey: string,
): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/recoverable-extension",
      version: "2.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.extension",
        apiVersion: "^0.3.0",
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
    encode(value) {
      const control = globalThis[${JSON.stringify(controlKey)}];
      if (id === "fixture.output" && control.rejectOutput === true) {
        return { ok: false, issues: [{ code: "invalid_output", path: "" }] };
      }
      return { ok: true, value };
    },
  });
  context.registerOperation({
    id: "fixture.review",
    input: codec("fixture.input"),
    output: codec("fixture.output"),
    progress: codec("fixture.progress"),
    async execute(input, operation) {
      const control = globalThis[${JSON.stringify(controlKey)}];
      control.executeCalls += 1;
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
      control.onEvidenceDurable?.();
      if (control.releaseExecute !== undefined) {
        await control.releaseExecute;
      }
      return output;
    },
    async reconcile(_input, operation) {
      const control = globalThis[${JSON.stringify(controlKey)}];
      control.reconcileCalls += 1;
      const record = await operation.evidence.records.get(
        \`operations/\${operation.operationId}\`,
      );
      if (record === undefined || record.value.status !== "completed") {
        return { status: "inspection_required", message: "Completion evidence is missing." };
      }
      if (control.forgeInspectionEvidence === true) {
        return {
          status: "inspection_required",
          message: "Foreign evidence must not become terminal truth.",
          evidence: [
            {
              type: "record",
              record: {
                byteCount: record.byteCount,
                contract: record.contract,
                digest: record.digest,
                key: record.key,
                provenance: {
                  ...record.provenance,
                  operationId: "00000000-0000-4000-8000-000000000000",
                },
              },
            },
          ],
        };
      }
      if (control.foreignArtifact !== undefined) {
        return {
          status: "completed",
          output: record.value.output,
          artifacts: [
            {
              ...control.foreignArtifact,
              provenance: {
                ...control.foreignArtifact.provenance,
                contributionId: operation.provenance.contributionId,
                extensionId: operation.provenance.extensionId,
                extensionVersion: operation.provenance.extensionVersion,
                operationId: operation.operationId,
                projectId: operation.provenance.projectId,
              },
            },
          ],
        };
      }
      if (control.recoveryOutcome === "failed") {
        return {
          status: "failed",
          error: { code: "extension_execution_failed", message: "Evidence proves failure." },
          artifacts: [record.value.artifact],
        };
      }
      if (control.recoveryOutcome === "inspection") {
        return {
          status: "inspection_required",
          message: "Evidence is incomplete.",
          evidence: [
            {
              type: "record",
              record: {
                byteCount: record.byteCount,
                contract: record.contract,
                digest: record.digest,
                key: record.key,
                provenance: record.provenance,
              },
            },
          ],
        };
      }
      const bytes = await operation.evidence.artifacts.read(record.value.artifact);
      if (bytes === undefined) {
        return { status: "inspection_required", message: "Completion artifact is missing." };
      }
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

async function expectStableReconciliationOutcome(fixture: {
  readonly expected: Record<string, unknown>;
  readonly outcome: "failed" | "inspection";
  readonly terminalType: "operation_failed" | "operation_inspection_required";
}): Promise<void> {
  const testRoot = await mkdtemp(join(tmpdir(), `adam-agent-operation-${fixture.outcome}-`));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const stateRoot = join(testRoot, "state");
  const controlKey = `__adamOperationRecoveryOutcome${Date.now()}${Math.random()}`;
  const control = { executeCalls: 0, reconcileCalls: 0, recoveryOutcome: fixture.outcome };
  (globalThis as Record<string, unknown>)[controlKey] = control;
  try {
    await mkdir(workspaceRoot);
    const artifactStore = await createFileArtifactStore({ root: join(stateRoot, "artifacts") });
    const durableStore = createInMemoryOperationStore();
    let rejectOriginalTerminal = true;
    const interruptedStore: OperationStore = {
      append(record) {
        if (rejectOriginalTerminal && record.event.type === "operation_completed") {
          rejectOriginalTerminal = false;
          return Promise.reject(new Error("injected original terminal persistence failure"));
        }
        return durableStore.append(record);
      },
      findByIdempotency: (scope) => durableStore.findByIdempotency(scope),
      listLinkedStarts: (options) => durableStore.listLinkedStarts(options),
      read: (operationId) => durableStore.read(operationId),
    };
    await writeRecoverableOperationExtension(packageRoot, controlKey);
    const configured = {
      enabled: true,
      extensionId: "fixture.extension",
      grants: [
        { id: "adam.artifact.publish@1", version: "^1.0.0" },
        { id: "adam.storage.records@1", version: "^1.0.0" },
      ],
      packageName: "@fixture/recoverable-extension",
      packageRoot,
      packageVersion: "2.0.0",
    } as const;
    const capabilities = [
      { id: "adam.artifact.publish@1", version: "1.0.0" },
      { id: "adam.storage.records@1", version: "1.0.0" },
    ] as const;
    const firstHost = createExtensionHost({
      artifactStore,
      capabilities,
      extensions: [configured],
      operationStore: interruptedStore,
      projectRoot: workspaceRoot,
      stateRoot,
    });
    await firstHost.loadConfiguredExtensions();
    const started = await firstHost.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: `review-reconcile-${fixture.outcome}-1`,
      input: { revision: fixture.outcome },
    });
    for await (const _record of firstHost.operations.events({ operationId: started.operationId })) {
      // The interrupted durable stream is the synchronization point.
    }
    const recoveredHost = createExtensionHost({
      artifactStore,
      capabilities,
      extensions: [configured],
      operationStore: durableStore,
      projectRoot: workspaceRoot,
      stateRoot,
    });
    await recoveredHost.loadConfiguredExtensions();
    await expect(recoveredHost.operations.cancel(started.operationId)).resolves.toMatchObject({
      status: "recovery_required",
    });
    const recovered = await recoveredHost.operations.recover(started.operationId);
    const beforeRepeat = await durableStore.read(started.operationId);
    const repeated = await recoveredHost.operations.recover(started.operationId);

    expect(recovered).toMatchObject(fixture.expected);
    expect(repeated).toEqual(recovered);
    expect(control).toMatchObject({ executeCalls: 1, reconcileCalls: 1 });
    expect(beforeRepeat.at(-1)?.event.type).toBe(fixture.terminalType);
    expect(await durableStore.read(started.operationId)).toEqual(beforeRepeat);
  } finally {
    delete (globalThis as Record<string, unknown>)[controlKey];
    await rm(testRoot, { recursive: true, force: true });
  }
}

async function writeInvalidRecoveryHandlerExtension(packageRoot: string): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/invalid-recovery-extension",
      version: "2.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.extension",
        apiVersion: "^0.3.0",
        runtime: { entry: "./runtime.js" },
        capabilities: { required: [], optional: [] },
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
    execute(input) { return input; },
    reconcile: "invalid",
  });
}
`,
    "utf8",
  );
}

async function writeRecoveryDeclarationMismatchExtension(
  packageRoot: string,
  fixture: { readonly manifestRecovery: boolean; readonly registrationRecovery: boolean },
): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/recovery-declaration-extension",
      version: "2.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.extension",
        apiVersion: "^0.3.0",
        runtime: { entry: "./runtime.js" },
        capabilities: { required: [], optional: [] },
        contributions: [
          {
            kind: "operation",
            id: "fixture.review",
            input: { id: "fixture.input", version: 1 },
            output: { id: "fixture.output", version: 1 },
            progress: { id: "fixture.progress", version: 1 },
            ...(fixture.manifestRecovery ? { recovery: { version: 1 } } : {}),
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
    execute(input) { return input; },
    ${fixture.registrationRecovery ? 'reconcile(input) { return { status: "completed", output: input }; },' : ""}
  });
}
`,
    "utf8",
  );
}

async function writeGrantSensitiveRecoveryExtension(
  packageRoot: string,
  controlKey: string,
  packageVersion = "2.0.0",
): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/grant-recovery-extension",
      version: packageVersion,
      type: "module",
      adamAgent: {
        id: "fixture.extension",
        apiVersion: "^0.3.0",
        runtime: { entry: "./runtime.js" },
        capabilities: {
          required: [{ id: "fixture.capability@1", version: "^1.0.0" }],
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
    decode(value) {
      const control = globalThis[${JSON.stringify(controlKey)}];
      if (id === "fixture.input" && control.rejectInput === true) {
        return { ok: false, issues: [{ code: "invalid_input", path: "" }] };
      }
      return { ok: true, value };
    },
    encode(value) {
      const control = globalThis[${JSON.stringify(controlKey)}];
      if (id === "fixture.output" && control.rejectOutput === true) {
        return { ok: false, issues: [{ code: "invalid_output", path: "" }] };
      }
      return { ok: true, value };
    },
  });
  context.registerOperation({
    id: "fixture.review",
    input: codec("fixture.input"),
    output: codec("fixture.output"),
    progress: codec("fixture.progress"),
    execute(input) {
      globalThis[${JSON.stringify(controlKey)}].executeCalls += 1;
      return { accepted: true, revision: input.revision };
    },
    reconcile(input) {
      const control = globalThis[${JSON.stringify(controlKey)}];
      control.reconcileCalls += 1;
      control.reconcileEntered?.();
      if (control.hangReconcile === true) {
        return new Promise(() => {});
      }
      if (control.rejectFailure === true) {
        return { status: "failed", error: { code: "invalid_failure", message: "invalid" } };
      }
      return { status: "completed", output: { accepted: true, revision: input.revision } };
    },
  });
}
`,
    "utf8",
  );
}

async function expectRecoveryValidationMismatch(fixture: {
  readonly expectedCode?: "operation_input_invalid";
  readonly expectedStatus?: "recovery_required";
  readonly mode: "rejectFailure" | "rejectInput" | "rejectOutput";
  readonly reconcileCalls: number;
}): Promise<void> {
  const testRoot = await mkdtemp(join(tmpdir(), `adam-agent-operation-${fixture.mode}-`));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const controlKey = `__adamOperationRecoveryValidation${Date.now()}${Math.random()}`;
  const control: Record<string, unknown> = { executeCalls: 0, reconcileCalls: 0 };
  (globalThis as Record<string, unknown>)[controlKey] = control;
  try {
    await mkdir(workspaceRoot);
    await writeGrantSensitiveRecoveryExtension(packageRoot, controlKey);
    const durableStore = createInMemoryOperationStore();
    let rejectOriginalTerminal = true;
    const interruptedStore: OperationStore = {
      append(record) {
        if (rejectOriginalTerminal && record.event.type === "operation_completed") {
          rejectOriginalTerminal = false;
          return Promise.reject(new Error("injected original terminal persistence failure"));
        }
        return durableStore.append(record);
      },
      findByIdempotency: (scope) => durableStore.findByIdempotency(scope),
      listLinkedStarts: (options) => durableStore.listLinkedStarts(options),
      read: (operationId) => durableStore.read(operationId),
    };
    const configured = {
      enabled: true,
      extensionId: "fixture.extension",
      grants: [{ id: "fixture.capability@1", version: "^1.0.0" }],
      packageName: "@fixture/grant-recovery-extension",
      packageRoot,
      packageVersion: "2.0.0",
    } as const;
    const capabilities = [{ id: "fixture.capability@1", version: "1.0.0" }] as const;
    const firstHost = createExtensionHost({
      capabilities,
      extensions: [configured],
      operationStore: interruptedStore,
      projectRoot: workspaceRoot,
    });
    await firstHost.loadConfiguredExtensions();
    const started = await firstHost.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: `review-reconcile-${fixture.mode}-1`,
      input: { revision: fixture.mode },
    });
    for await (const _record of firstHost.operations.events({ operationId: started.operationId })) {
      // The interrupted durable stream is the synchronization point.
    }
    control[fixture.mode] = true;
    const recoveredHost = createExtensionHost({
      capabilities,
      extensions: [configured],
      operationStore: durableStore,
      projectRoot: workspaceRoot,
    });
    await recoveredHost.loadConfiguredExtensions();
    if (fixture.expectedCode !== undefined) {
      await expect(recoveredHost.operations.recover(started.operationId)).rejects.toMatchObject({
        code: fixture.expectedCode,
        name: "OperationHostError",
      });
    } else {
      await expect(recoveredHost.operations.recover(started.operationId)).resolves.toMatchObject({
        status: fixture.expectedStatus,
      });
    }
    expect(control).toMatchObject({ executeCalls: 1, reconcileCalls: fixture.reconcileCalls });
    expect(
      (await durableStore.read(started.operationId)).some((record) =>
        ["operation_completed", "operation_failed", "operation_inspection_required"].includes(
          record.event.type,
        ),
      ),
    ).toBe(false);
  } finally {
    delete (globalThis as Record<string, unknown>)[controlKey];
    await rm(testRoot, { recursive: true, force: true });
  }
}

async function expectRecoveryIdentityMismatch(fixture: {
  readonly expectedCode: "operation_contribution_unavailable" | "operation_store_project_mismatch";
  readonly mode: "project" | "version";
}): Promise<void> {
  const testRoot = await mkdtemp(join(tmpdir(), `adam-agent-operation-${fixture.mode}-mismatch-`));
  const firstWorkspaceRoot = join(testRoot, "workspace-a");
  const secondWorkspaceRoot = join(testRoot, "workspace-b");
  const firstPackageRoot = join(testRoot, "extension-a");
  const secondPackageRoot = join(testRoot, "extension-b");
  const controlKey = `__adamOperationRecoveryIdentity${Date.now()}${Math.random()}`;
  const control = { executeCalls: 0, reconcileCalls: 0 };
  (globalThis as Record<string, unknown>)[controlKey] = control;
  try {
    await mkdir(firstWorkspaceRoot);
    await mkdir(secondWorkspaceRoot);
    await writeGrantSensitiveRecoveryExtension(firstPackageRoot, controlKey);
    const durableStore = createInMemoryOperationStore();
    let rejectOriginalTerminal = true;
    const interruptedStore: OperationStore = {
      append(record) {
        if (rejectOriginalTerminal && record.event.type === "operation_completed") {
          rejectOriginalTerminal = false;
          return Promise.reject(new Error("injected original terminal persistence failure"));
        }
        return durableStore.append(record);
      },
      findByIdempotency: (scope) => durableStore.findByIdempotency(scope),
      listLinkedStarts: (options) => durableStore.listLinkedStarts(options),
      read: (operationId) => durableStore.read(operationId),
    };
    const capability = { id: "fixture.capability@1", version: "1.0.0" } as const;
    const configured = (packageRoot: string, packageVersion: string) => ({
      enabled: true,
      extensionId: "fixture.extension",
      grants: [{ id: "fixture.capability@1", version: "^1.0.0" }],
      packageName: "@fixture/grant-recovery-extension",
      packageRoot,
      packageVersion,
    });
    const firstHost = createExtensionHost({
      capabilities: [capability],
      extensions: [configured(firstPackageRoot, "2.0.0")],
      operationStore: interruptedStore,
      projectRoot: firstWorkspaceRoot,
    });
    await firstHost.loadConfiguredExtensions();
    const started = await firstHost.operations.start({
      contributionId: "fixture.review",
      idempotencyKey: `review-reconcile-${fixture.mode}-mismatch-1`,
      input: { revision: fixture.mode },
    });
    for await (const _record of firstHost.operations.events({ operationId: started.operationId })) {
      // The interrupted durable stream is the synchronization point.
    }
    if (fixture.mode === "version") {
      await writeGrantSensitiveRecoveryExtension(secondPackageRoot, controlKey, "2.0.1");
    }
    const recoveredHost = createExtensionHost({
      capabilities: [capability],
      extensions: [
        configured(
          fixture.mode === "version" ? secondPackageRoot : firstPackageRoot,
          fixture.mode === "version" ? "2.0.1" : "2.0.0",
        ),
      ],
      operationStore: durableStore,
      projectRoot: fixture.mode === "project" ? secondWorkspaceRoot : firstWorkspaceRoot,
    });
    await recoveredHost.loadConfiguredExtensions();

    await expect(recoveredHost.operations.recover(started.operationId)).rejects.toMatchObject({
      code: fixture.expectedCode,
      name: "OperationHostError",
    });
    expect(control).toEqual({ executeCalls: 1, reconcileCalls: 0 });
  } finally {
    delete (globalThis as Record<string, unknown>)[controlKey];
    await rm(testRoot, { recursive: true, force: true });
  }
}
