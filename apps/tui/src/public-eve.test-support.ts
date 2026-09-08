import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createJsonlOperationStore,
  createJsonlSessionStoreDirectory,
  createModelTargets,
  createPermissionPolicy,
  createPresentationPreferences,
  createWorkspaceTrust,
  type SessionRecord,
} from "@adam-agent/agent";
import {
  createJsonlManagedAgentControlStore,
  managedAgentSettlementBarrier,
} from "@adam-agent/agent/internal-testing";
import type { PresentationSession } from "@adam-agent/presentation";
import { createAdamCommandRegistryFromContributions } from "./command-registry.js";
import {
  createProductionProjectRuntime,
  projectRuntimeManagedControl,
  projectRuntimeReviewTiming,
} from "./project-runtime.js";
import { runTui } from "./tui-app.js";
import {
  terminalObservationTimeoutMilliseconds,
  VirtualTerminal,
} from "./virtual-terminal.test-support.js";

const exec = promisify(execFile);
export const emptyEveCandidates =
  '{"kind":"eve-reviewer.model-review-candidates","schemaVersion":1,"payload":{"candidates":[]}}';

export class EveReviewClock {
  private timestamp = Date.now();
  private readonly timers = new Set<{ at: number; fire(): void }>();
  now = () => this.timestamp;
  schedule(milliseconds: number, fire: () => void) {
    const timer = { at: this.timestamp + milliseconds, fire };
    this.timers.add(timer);
    return { cancel: () => void this.timers.delete(timer) };
  }
  advance(milliseconds: number) {
    this.timestamp += milliseconds;
    for (const timer of [...this.timers]) {
      if (timer.at > this.timestamp) continue;
      this.timers.delete(timer);
      timer.fire();
    }
  }
}

export async function awaitEveReceipt<T>(receipt: Promise<T>, description: string): Promise<T> {
  const expired = Promise.withResolvers<never>();
  const guard = setTimeout(
    () => expired.reject(new Error(description)),
    terminalObservationTimeoutMilliseconds,
  );
  try {
    return await Promise.race([receipt, expired.promise]);
  } finally {
    clearTimeout(guard);
  }
}

export async function observeEve(
  presentation: PresentationSession,
  predicate: () => boolean,
  description: string,
) {
  const reached = Promise.withResolvers<void>();
  const check = () => {
    if (predicate()) reached.resolve();
  };
  const unsubscribe = presentation.subscribe(check);
  const guard = setTimeout(
    () =>
      reached.reject(
        new Error(
          `${description}: ${JSON.stringify(presentation.getState().authoritative.active?.linkedOperations)}`,
        ),
      ),
    terminalObservationTimeoutMilliseconds,
  );
  try {
    check();
    await reached.promise;
  } finally {
    clearTimeout(guard);
    unsubscribe();
  }
}

type ChatRequest = {
  readonly messages: readonly { readonly role: string; readonly content: unknown }[];
  readonly tools?: readonly unknown[];
};

export type EveProviderStream = {
  readonly request: ChatRequest;
  readonly aborted: Promise<void>;
  text(value: string): void;
  finish(value?: string): void;
  tool(name: string, input: unknown): void;
};

export type PublicEveFixture = {
  readonly root: string;
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly sessionId: string;
  readonly requests: ChatRequest[];
  readonly reviews: EveProviderStream[];
  readonly children: EveProviderStream[];
  readonly controlStore: Awaited<ReturnType<typeof createJsonlManagedAgentControlStore>>;
  readonly operationStore: Awaited<ReturnType<typeof createJsonlOperationStore>>;
  readonly childSessionStores: ReturnType<typeof createJsonlSessionStoreDirectory<SessionRecord>>;
  readonly presentation: PresentationSession;
  review(index?: number): Promise<EveProviderStream>;
  child(index?: number): Promise<EveProviderStream>;
  startReview(): ReturnType<PresentationSession["dispatch"]>;
  startTui(): Promise<VirtualTerminal>;
  restart(): Promise<void>;
  close(): Promise<void>;
};

/** Only the external HTTP provider is controlled; all Adam/Eve owners and stores are real. */
export async function createPublicEveFixture(
  options: {
    readonly coexistence?: boolean;
    readonly clock?: EveReviewClock;
    readonly controlClock?: EveReviewClock;
    readonly totalMilliseconds?: number;
    readonly largeEvidence?: boolean;
    readonly settlementBarrier?: () => Promise<void>;
  } = {},
): Promise<PublicEveFixture> {
  const root = await mkdtemp(join(tmpdir(), "adam-public-eve-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  const configRoot = join(root, "config");
  await mkdir(workspaceRoot);
  await exec("git", ["init", "--quiet", "--initial-branch=main", workspaceRoot]);
  await exec("git", ["-C", workspaceRoot, "config", "user.name", "Adam Test"]);
  await exec("git", ["-C", workspaceRoot, "config", "user.email", "adam@example.invalid"]);
  await writeFile(join(workspaceRoot, "value.ts"), "export const value = 1;\n");
  await exec("git", ["-C", workspaceRoot, "add", "value.ts"]);
  await exec("git", ["-C", workspaceRoot, "commit", "--quiet", "-m", "fixture base"]);
  await writeFile(
    join(workspaceRoot, "value.ts"),
    `export const value = 2;\n${options.largeEvidence ? `// ${"bounded-evidence ".repeat(2_000)}\n` : ""}`,
  );
  await mkdir(join(configRoot, "adam-agent"), { recursive: true, mode: 0o700 });
  const packageRoot = await realpath(
    join(process.cwd(), "node_modules/@eve-reviewer/adam-extension"),
  );
  await writeFile(
    join(configRoot, "adam-agent/extensions.json"),
    JSON.stringify({
      schemaVersion: 1,
      extensions: [
        {
          enabled: true,
          extensionId: "eve-reviewer",
          grants: [
            { id: "adam.analyzer-execution.biome@1", version: "1.0.0" },
            { id: "adam.artifact.publish@1", version: "1.0.0" },
            { id: "adam.storage.records@1", version: "1.0.0" },
            { id: "adam.managed-review@1", version: "1.0.0" },
          ],
          packageName: "@eve-reviewer/adam-extension",
          packageRoot,
          packageVersion: "0.6.0",
        },
      ],
    }),
    { mode: 0o600 },
  );
  const environment = { XDG_CONFIG_HOME: configRoot, DEEPSEEK_API_KEY: "non-network-fixture" };
  const workspaceTrust = createWorkspaceTrust({ environment, workspaceRoot });
  const trust = await workspaceTrust.load();
  if (trust.projectId === null) throw new Error("Missing fixture project identity");
  await workspaceTrust.setTrusted({ projectId: trust.projectId, trusted: true });
  const requests: ChatRequest[] = [];
  const reviews: EveProviderStream[] = [];
  const children: EveProviderStream[] = [];
  const reviewStarts = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<EveProviderStream>>
  >();
  const childStarts = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<EveProviderStream>>
  >();
  const startReceipt = (starts: typeof reviewStarts, index: number) => {
    let receipt = starts.get(index);
    if (receipt === undefined) {
      receipt = Promise.withResolvers<EveProviderStream>();
      starts.set(index, receipt);
    }
    return receipt;
  };
  const waitForStart = (starts: typeof reviewStarts, index: number) =>
    awaitEveReceipt(startReceipt(starts, index).promise, "Missing external provider start");
  const modelTargets = createModelTargets({
    environment,
    fetch: async (_input, init) => {
      const request: ChatRequest = JSON.parse(String(init?.body));
      requests.push(request);
      const isReview = JSON.stringify(request.messages).includes(
        "Eve Reviewer's single model-review stage",
      );
      const isChild = JSON.stringify(request.messages).includes("Concurrent child evidence");
      const abort = Promise.withResolvers<void>();
      let controller: ReadableStreamDefaultController<Uint8Array>;
      let closed = false;
      const encoder = new TextEncoder();
      const send = (value: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      const stream = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
        cancel() {
          closed = true;
          abort.resolve();
        },
      });
      let toolCall = false;
      const provider: EveProviderStream = {
        tool(name, input) {
          toolCall = true;
          send({
            id: "fixture",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call-${requests.length}`,
                      type: "function",
                      function: { name, arguments: JSON.stringify(input) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
            model: "fixture",
            created: 1,
            object: "chat.completion.chunk",
          });
          provider.finish();
        },
        request,
        aborted: abort.promise,
        text(value) {
          if (closed) throw new Error("Provider already closed");
          send({
            id: "fixture",
            choices: [
              { index: 0, delta: { role: "assistant", content: value }, finish_reason: null },
            ],
            model: "fixture",
            created: 1,
            object: "chat.completion.chunk",
          });
        },
        finish(value) {
          if (closed) return;
          if (value !== undefined) provider.text(value);
          send({
            id: "fixture",
            choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }],
            model: "fixture",
            created: 1,
            object: "chat.completion.chunk",
          });
          send({
            id: "fixture",
            choices: [],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
            model: "fixture",
            created: 1,
            object: "chat.completion.chunk",
          });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          closed = true;
        },
      };
      init?.signal?.addEventListener(
        "abort",
        () => {
          abort.resolve();
          if (!closed) {
            controller.error(new DOMException("Cancelled", "AbortError"));
            closed = true;
          }
        },
        { once: true },
      );
      if (isReview) {
        startReceipt(reviewStarts, reviews.length).resolve(provider);
        reviews.push(provider);
      } else if (isChild) {
        startReceipt(childStarts, children.length).resolve(provider);
        children.push(provider);
      } else if (
        options.coexistence &&
        request.messages.at(-1)?.role === "user" &&
        String(request.messages.at(-1)?.content).includes("Initialize public")
      ) {
        provider.tool("create_todo", {
          title: "Verify production coexistence",
          activeForm: "Verifying coexistence",
        });
      } else if (
        options.coexistence &&
        request.messages.at(-1)?.role === "user" &&
        String(request.messages.at(-1)?.content).includes("Prepare coexistence Plan")
      ) {
        provider.tool("submit_plan", {
          title: "Coexistence Plan",
          markdown: "# Coexistence Plan\n\n1. Inspect evidence.\n2. Verify controls.\n",
        });
      } else provider.finish("Origin ready");
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const controlStore = await createJsonlManagedAgentControlStore({ workspaceRoot, stateRoot });
  const operationStore = await createJsonlOperationStore({ workspaceRoot, stateRoot });
  const childSessionStores = createJsonlSessionStoreDirectory<SessionRecord>({
    workspaceRoot,
    stateRoot: join(stateRoot, "managed-agent-sessions"),
  });
  const preferences = createPresentationPreferences({ environment });
  const runtimeOptions = {
    ...(options.controlClock === undefined && options.settlementBarrier === undefined
      ? {}
      : {
          [projectRuntimeManagedControl]: {
            store: controlStore,
            childSessionStores,
            ...(options.controlClock === undefined
              ? {}
              : { inactivityScheduler: options.controlClock }),
            ...(options.settlementBarrier === undefined
              ? {}
              : { [managedAgentSettlementBarrier]: options.settlementBarrier }),
          },
        }),
    ...(options.clock === undefined
      ? {}
      : {
          [projectRuntimeReviewTiming]: {
            operationNow: options.clock.now,
            operationDeadlineScheduler: options.clock,
            review: {
              deadlineScheduler: options.clock,
              ...(options.totalMilliseconds === undefined
                ? {}
                : {
                    policy: { version: 1 as const, totalMilliseconds: options.totalMilliseconds },
                  }),
            },
          },
        }),
    environment,
    workspaceRoot,
    stateRoot,
    workspaceTrust,
    modelTargets,
    preferences,
    projectLabel: "Public Eve fixture",
    reservedCommandNames: [],
    permissions: createPermissionPolicy(
      options.coexistence
        ? { allowedEffects: ["write", "delegate"], askedEffects: ["read", "network"] }
        : { allowedEffects: ["read", "delegate"] },
    ),
    extensionPermissions: createPermissionPolicy({ allowedEffects: ["execute"] }),
  };
  let runtime = await createProductionProjectRuntime(runtimeOptions);
  let presentation = await runtime.createPresentation({ openProject: true });
  await presentation.dispatch({ type: "create_session", targetId: "deepseek-v4-flash.direct" });
  await presentation.dispatch({
    type: "submit_draft_prompt",
    text: "Initialize public review origin.",
    skills: [],
    thinkingSelection: null,
  });
  await observeEve(
    presentation,
    () => presentation.getState().authoritative.active?.session.status === "settled",
    "Missing durable origin",
  );
  const sessionId = presentation.getState().authoritative.active?.session.id;
  if (sessionId === undefined) throw new Error("Missing origin Session");
  let terminal: VirtualTerminal | undefined;
  let running: Promise<void> | undefined;
  return {
    root,
    workspaceRoot,
    stateRoot,
    sessionId,
    requests,
    reviews,
    children,
    controlStore,
    operationStore,
    childSessionStores,
    get presentation() {
      return presentation;
    },
    review: (index = 0) => waitForStart(reviewStarts, index),
    child: (index = 0) => waitForStart(childStarts, index),
    async startReview() {
      return presentation.dispatch({
        type: "start_project_changes",
        sessionId,
        command: { id: "eve-reviewer.local-worktree-review", version: 1 },
      });
    },
    async startTui() {
      terminal = new VirtualTerminal({ columns: 120, rows: 40 });
      running = runTui({
        presentation,
        terminal,
        commandRegistry: createAdamCommandRegistryFromContributions(runtime.contributions),
        closeRuntime: () => runtime.close(),
        mouse: true,
      });
      void running.catch(() => undefined);
      await terminal.waitForScreen("Origin ready");
      return terminal;
    },
    async restart() {
      if (running !== undefined) {
        terminal?.input("\u0011");
        await awaitEveReceipt(running, "TUI did not close for restart");
        running = undefined;
      }
      await runtime.close();
      runtime = await createProductionProjectRuntime(runtimeOptions);
      presentation = await runtime.createPresentation({ sessionId });
    },
    async close() {
      if (running !== undefined) {
        terminal?.input("\u0011");
        await awaitEveReceipt(running, "TUI did not close");
      }
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
