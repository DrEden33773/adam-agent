import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ArtifactStore,
  createExtensionHost,
  createFileArtifactStore,
  createInMemoryOperationStore,
  createJsonlOperationStore,
  createPermissionPolicy,
  type ExtensionHostOptions,
  type ModelDriver,
  type ModelRequest,
  type OperationEventRecord,
  type OperationStore,
} from "@adam-agent/agent";
import {
  createInMemoryManagedAgentControlStore,
  createInMemorySessionStoreDirectory,
  createJsonlManagedAgentControlStore,
  createJsonlSessionStoreDirectory,
  createManagedAgentControl,
  createOperationHost,
  createProjectExecutionDomain,
  managedAgentSettlementBarrier,
  projectExecutionDomainForExtensionHost,
  type RegisteredOperation,
  type SessionRecord,
} from "@adam-agent/agent/internal-testing";
import type { ExtensionOperationRegistration } from "@adam-agent/extension-api";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";

export async function createManagedReviewHarness(
  options: {
    readonly model?: ModelDriver;
    readonly execute?: string;
    readonly originStatus?: "target_unavailable" | "policy_denied";
    readonly durableRoot?: string;
    readonly os?: boolean;
    readonly beforeResolveOrigin?: () => Promise<void>;
    readonly clock?: NonNullable<ExtensionHostOptions["operationDeadlineScheduler"]> & {
      now(): number;
    };
    readonly reviewPolicy?: { readonly version: 1; readonly totalMilliseconds: number };
    readonly evidenceText?: string;
    readonly settlementBarrier?: () => Promise<void>;
    readonly managedDecoder?: string;
  } = {},
) {
  const filesystem = options.os === true || options.durableRoot !== undefined;
  const root =
    options.durableRoot ??
    (filesystem ? await mkdtemp(join(tmpdir(), "adam-managed-review-")) : process.cwd());
  const packageRoot = join(root, "extension");
  const workspaceRoot = filesystem ? join(root, "workspace") : process.cwd();
  if (filesystem) {
    await mkdir(packageRoot);
    await mkdir(workspaceRoot);
    await mkdir(join(packageRoot, "node_modules", "@adam-agent"), { recursive: true });
    await symlink(
      fileURLToPath(new URL("../", import.meta.resolve("@adam-agent/extension-api"))),
      join(packageRoot, "node_modules", "@adam-agent", "extension-api"),
    );
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@fixture/purpose-review",
        version: "1.0.0",
        type: "module",
        adamAgent: {
          id: "fixture.purpose-review",
          apiVersion: ">=0.6.0 <0.7.0",
          runtime: { entry: "./runtime.js" },
          capabilities: {
            required: [
              { id: "adam.artifact.publish@1", version: "^1.0.0" },
              { id: "adam.managed-review@1", version: "^1.0.0" },
            ],
            optional: [],
          },
          contributions: [
            {
              kind: "operation",
              id: "fixture.purpose-review",
              input: { id: "fixture.input", version: 1 },
              output: { id: "fixture.output", version: 1 },
              progress: { id: "fixture.progress", version: 1 },
              managedOutput: { id: "fixture.verdict", version: 1 },
            },
          ],
        },
      }),
    );
  }
  const runtimeSource = `
import { extensionManagedReviewTerminalCodec } from "@adam-agent/extension-api";
export function activate(context) {
  const codec = id => ({ id, version: 1, decode: value => ({ ok: true, value }), encode: value => ({ ok: true, value }) });
  context.registerOperation({
    id: "fixture.purpose-review", input: codec("fixture.input"), output: codec("fixture.output"), progress: codec("fixture.progress"),
    managedOutput: { ...codec("fixture.verdict"), decode: ${options.managedDecoder ?? 'value => value?.verdict === "verified" ? { ok: true, value } : { ok: false, issues: [{ code: "invalid", path: "/verdict" }] }'} },
    async execute(_input, operation) {
      const artifact = await operation.capabilities["adam.artifact.publish@1"].publish({ bytes: new TextEncoder().encode(${JSON.stringify(options.evidenceText ?? "immutable review evidence")}), contract: { id: "fixture.evidence", version: 1 }, mediaType: "text/plain; charset=utf-8" });
      const capability = operation.capabilities["adam.managed-review@1"];
      const request = { evidence: [{ type: "artifact", artifact }], instruction: "Return the verified verdict.", outputContract: { id: "fixture.verdict", version: 1 } };
      ${
        options.execute ??
        `const terminal = await capability.review(request);
      const decoded = extensionManagedReviewTerminalCodec.decode(terminal);
      if (!decoded.ok) throw new Error("Invalid public review terminal");
      return { terminal: decoded.value, capabilityKeys: Object.keys(capability) };`
      }
    }
  });
}
`;
  if (filesystem) await writeFile(join(packageRoot, "runtime.js"), runtimeSource);
  const artifacts = new Map<string, Uint8Array>();
  const artifactStore: ArtifactStore = filesystem
    ? await createFileArtifactStore({ root: join(root, "artifacts") })
    : {
        async write(input) {
          const bytes = input.bytes.slice();
          const id = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
          artifacts.set(id, bytes);
          return {
            id,
            byteCount: bytes.byteLength,
            mediaType: input.mediaType,
            source: input.source,
          };
        },
        async read(id, limits) {
          const bytes = artifacts.get(id);
          if (bytes === undefined) return undefined;
          if (limits?.maximumBytes !== undefined && bytes.byteLength > limits.maximumBytes)
            throw new Error("Fixture artifact exceeds read limit");
          return bytes.slice();
        },
      };
  const executionDomain = filesystem
    ? undefined
    : createProjectExecutionDomain({
        lifecycleOwner: {
          acquire: async () => ({ release: async () => {} }),
          run: (operation) => operation(),
        },
      });
  const requests: ModelRequest[] = [];
  const durableOptions = { workspaceRoot, stateRoot: join(root, "state") };
  const operationStore =
    options.durableRoot === undefined
      ? createInMemoryOperationStore()
      : await createJsonlOperationStore(durableOptions);
  const controlStore =
    options.durableRoot === undefined
      ? createInMemoryManagedAgentControlStore()
      : await createJsonlManagedAgentControlStore(durableOptions);
  const childSessionStores =
    options.durableRoot === undefined
      ? createInMemorySessionStoreDirectory<SessionRecord>()
      : createJsonlSessionStoreDirectory<SessionRecord>({
          workspaceRoot,
          stateRoot: join(root, "children"),
        });
  let control: ReturnType<typeof createManagedAgentControl> | undefined;
  const targetIdentity = {
    targetId: "fixture.review",
    vendor: "fixture",
    modelId: "review",
    route: "direct",
    profileVersion: 1,
    certification: "certified",
  } as const;
  const contextProfile = {
    version: 1,
    contextWindowTokens: 128_000,
    maximumOutputTokens: 4096,
    compactAtTokens: 96_000,
    postCompactTargetTokens: 32_000,
    retainedTargetTokens: 8_000,
    estimatorVersion: 1,
  } as const;
  const model: ModelDriver = {
    async *stream(request) {
      requests.push(request);
      if (options.model !== undefined) {
        yield* options.model.stream(request);
        return;
      }
      yield { type: "text_delta", text: '{"verdict":"verified"}' };
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const hostOptions: ExtensionHostOptions = {
    ...(options.clock === undefined
      ? {}
      : {
          operationDeadlineScheduler: options.clock,
          operationNow: () => options.clock?.now() ?? Date.now(),
        }),
    artifactStore,
    managedReview: {
      ...(options.clock === undefined ? {} : { deadlineScheduler: options.clock }),
      ...(options.reviewPolicy === undefined ? {} : { policy: options.reviewPolicy }),
      async resolveOrigin({ origin, projectId }) {
        await options.beforeResolveOrigin?.();
        if (options.originStatus !== undefined) return { status: options.originStatus };
        const domain =
          executionDomain ??
          projectExecutionDomainForExtensionHost(host as ReturnType<typeof createExtensionHost>);
        if (domain === undefined) throw new Error("Missing project domain");
        control ??= createManagedAgentControl({
          ...(options.settlementBarrier === undefined
            ? {}
            : { [managedAgentSettlementBarrier]: options.settlementBarrier }),
          ...(options.clock === undefined
            ? {}
            : {
                inactivityScheduler: options.clock,
                cleanupScheduler: options.clock,
                now: () => options.clock?.now() ?? Date.now(),
              }),
          parentSessionId: origin.sessionId,
          projectId,
          workspaceRoot,
          executionDomain: domain,
          artifactStore,
          store: controlStore,
          childSessionStores,
          permissions: createPermissionPolicy({ allowedEffects: [] }),
          targetIdentity,
          contextProfile,
          model,
        });
        return { status: "ready", control, model, targetIdentity, contextProfile };
      },
    },
    capabilities: [
      { id: "adam.artifact.publish@1", version: "1.0.0" },
      { id: "adam.managed-review@1", version: "1.0.0" },
    ],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.purpose-review",
        grants: [
          { id: "adam.artifact.publish@1", version: "^1.0.0" },
          { id: "adam.managed-review@1", version: "^1.0.0" },
        ],
        packageName: "@fixture/purpose-review",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    operationOriginAuthority: { validateBoundary: async () => true },
    operationStore,
    projectRoot: workspaceRoot,
    stateRoot: join(root, "state"),
  };
  const runtime = filesystem
    ? undefined
    : ((await import(
        `data:text/javascript;base64,${Buffer.from(runtimeSource.replace('"@adam-agent/extension-api"', JSON.stringify(import.meta.resolve("@adam-agent/extension-api")))).toString("base64")}`
      )) as {
        activate(context: {
          registerOperation(registration: ExtensionOperationRegistration): void;
        }): void;
      });
  let registration: ExtensionOperationRegistration | undefined;
  runtime?.activate({
    registerOperation(value) {
      registration = value;
    },
  });
  function createHost(candidate: ExtensionHostOptions): {
    operations: ReturnType<typeof createExtensionHost>["operations"];
    loadConfiguredExtensions(): Promise<{ extensions: readonly { status: string }[] }>;
  } {
    if (filesystem) return createExtensionHost(candidate);
    if (registration === undefined || executionDomain === undefined)
      throw new Error("Missing in-process registration");
    const registered: RegisteredOperation = {
      capabilityIds: ["adam.artifact.publish@1", "adam.managed-review@1"],
      contributionId: "fixture.purpose-review",
      contribution: {
        kind: "operation",
        id: "fixture.purpose-review",
        input: { id: "fixture.input", version: 1 },
        output: { id: "fixture.output", version: 1 },
        progress: { id: "fixture.progress", version: 1 },
        managedOutput: { id: "fixture.verdict", version: 1 },
      },
      definitionDigest: `sha256:${"a".repeat(64)}`,
      diagnostics: [],
      extensionId: "fixture.purpose-review",
      extensionVersion: "1.0.0",
      registration,
    };
    return {
      operations: createOperationHost({
        artifactStore,
        executionDomain,
        projectRoot: workspaceRoot,
        ...(candidate.operationStore === undefined ? {} : { store: candidate.operationStore }),
        ...(candidate.managedReview === undefined
          ? {}
          : { managedReview: candidate.managedReview }),
        ...(candidate.operationDeadlineScheduler === undefined
          ? {}
          : { deadlineScheduler: candidate.operationDeadlineScheduler }),
        ...(candidate.operationNow === undefined ? {} : { now: candidate.operationNow }),
        originAuthority: { validateBoundary: async () => true },
        resolveOperation: (id) => (id === registered.contributionId ? registered : undefined),
      }),
      loadConfiguredExtensions: async () => ({ extensions: [{ status: "active" }] }),
    };
  }
  const host = createHost(hostOptions);
  return {
    host,
    requests,
    operationStore,
    artifactStore,
    control(): ReturnType<typeof createManagedAgentControl> {
      if (control === undefined) throw new Error("No Control has been resolved.");
      return control;
    },
    controlStore(): ReturnType<typeof createInMemoryManagedAgentControlStore> {
      return controlStore;
    },
    coldHost(store: OperationStore) {
      return createHost({
        ...hostOptions,
        operationStore: store,
        managedReview: {
          async resolveOrigin() {
            throw new Error("Cold recovery must not create a reviewer.");
          },
        },
      });
    },
    async start(idempotencyKey = "first-review") {
      const loaded = await host.loadConfiguredExtensions();
      if (loaded.extensions[0]?.status !== "active") throw new Error(JSON.stringify(loaded));
      return host.operations.startLinked({
        contributionId: "fixture.purpose-review",
        idempotencyKey,
        input: {},
        origin: {
          invocation: { id: "review", kind: "presentation_command", version: 1 },
          sessionId: "00000000-0000-4000-8000-000000000001",
          sourceSequence: 3,
        },
      });
    },
    async events(operationId: string): Promise<OperationEventRecord[]> {
      const events = [];
      for await (const record of host.operations.events({ operationId })) events.push(record);
      return events;
    },
    async close() {
      await control?.dispatch({
        type: "close",
        parentSessionId: "00000000-0000-4000-8000-000000000001",
      });
      if (filesystem) await rm(root, { recursive: true, force: true });
    },
  };
}

export class ReviewClock {
  private timestamp = Date.parse("2026-09-07T00:00:00.000Z");
  private readonly timers = new Set<{ at: number; fire(): void }>();
  now() {
    return this.timestamp;
  }
  schedule(milliseconds: number, fire: () => void) {
    const timer = { at: this.timestamp + milliseconds, fire };
    this.timers.add(timer);
    return {
      cancel: () => {
        this.timers.delete(timer);
      },
    };
  }
  advance(milliseconds: number) {
    this.timestamp += milliseconds;
    for (const timer of [...this.timers].sort((left, right) => left.at - right.at)) {
      if (timer.at <= this.timestamp && this.timers.delete(timer)) timer.fire();
    }
  }
}

export function streamingReviewModel() {
  const started = Promise.withResolvers<void>();
  const pending: {
    text: string | null;
    accepted: ReturnType<typeof Promise.withResolvers<void>>;
  }[] = [];
  let wake = Promise.withResolvers<void>();
  const model: ModelDriver = {
    async *stream(request) {
      const abort = () => wake.resolve();
      request.signal.addEventListener("abort", abort, { once: true });
      started.resolve();
      try {
        while (!request.signal.aborted) {
          if (pending.length === 0) await wake.promise;
          wake = Promise.withResolvers<void>();
          const item = pending.shift();
          if (item !== undefined) {
            if (item.text === null) {
              yield { type: "usage", inputTokens: 10, outputTokens: 5 };
              yield { type: "finish", reason: "stop" };
              return;
            }
            yield { type: "text_delta", text: item.text };
            item.accepted.resolve();
          }
        }
      } finally {
        request.signal.removeEventListener("abort", abort);
      }
    },
  };
  return {
    model,
    started: started.promise,
    async text(text: string) {
      const accepted = Promise.withResolvers<void>();
      pending.push({ text, accepted });
      wake.resolve();
      await withManagedFailureGuard(accepted.promise, "Provider delta was not consumed");
    },
    finish() {
      pending.push({ text: null, accepted: Promise.withResolvers<void>() });
      wake.resolve();
    },
  };
}
