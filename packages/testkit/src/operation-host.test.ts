import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createExtensionHost,
  createInMemoryOperationStore,
  createJsonlOperationStore,
  type OperationStore,
} from "@adam-agent/agent";
import { expect, test } from "vitest";

test("ExtensionHost starts one durable operation and reuses it for the same idempotent input", async () => {
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
    });
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
    expect(records.map((record) => record.event)).toEqual([
      {
        type: "operation_started",
        contributionId: "fixture.review",
        deadlineAt: expect.any(String),
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
      status: "completed",
    });
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
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-terminal-persistence-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const durableStore = createInMemoryOperationStore();
  const store: OperationStore = {
    append(record) {
      if (record.event.type === "operation_failed") {
        return Promise.reject(new Error("injected terminal persistence failure"));
      }
      return durableStore.append(record);
    },
    findByIdempotency: (scope) => durableStore.findByIdempotency(scope),
    read: (operationId) => durableStore.read(operationId),
  };

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
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-deadline-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

  try {
    await mkdir(workspaceRoot);
    await writeOperationExtension(
      packageRoot,
      `if (!context.signal.aborted) {
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
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-disable-deadline-"));
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");

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
    for await (const _record of host.operations.events({ operationId: started.operationId })) {
      // The durable deadline terminal fact is the synchronization point.
    }

    await expect(host.disableExtension("fixture.extension")).resolves.toMatchObject({
      extensionId: "fixture.extension",
      status: "disabled_with_pending_operations",
    });
    await expect(host.operations.query(started.operationId)).resolves.toMatchObject({
      error: { code: "operation_deadline_exceeded" },
      status: "failed",
    });
  } finally {
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
        apiVersion: "^0.1.0",
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
