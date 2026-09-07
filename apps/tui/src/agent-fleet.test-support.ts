import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPermissionPolicy,
  createPresentationSession,
  createSessionLifecycle,
  type ModelDriver,
  type ModelTargets,
} from "@adam-agent/agent";
import {
  createDirectDeepSeekThinkingCapability,
  createInMemoryManagedAgentControlStore,
  createInMemorySessionStoreDirectory,
  createJsonlSessionStoreDirectory,
  createTrustedWorkspaceTrustForTesting,
  managedAgentRecordBarrier,
  managedAgentSettlementBarrier,
  presentationManagedControlReceiptBarrier,
  presentationSessionRecordReader,
  type SessionRecord,
  sessionAutomaticTitlesEnabled,
  sessionManagedControl,
  sessionProjectLifecycleOwner,
  sessionRecordCommittedBarrier,
  sessionStoreDirectory,
} from "@adam-agent/agent/internal-testing";
import type {
  ManagedAttentionItem,
  ManagedControlCommand,
  ManagedControlReceipt,
} from "@adam-agent/presentation";
import { onTestFailed } from "vitest";
import { type DeadlineScheduler, runTui } from "./tui-app.js";
import { VirtualTerminal } from "./virtual-terminal.test-support.js";

const identity = {
  targetId: "deepseek-v4-flash.direct",
  vendor: "deepseek",
  modelId: "deepseek-v4-flash",
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
  retainedTargetTokens: 8000,
  estimatorVersion: 1,
} as const;

export type ManagedTuiStorage = {
  readonly stateRoot: string;
  readonly sessions: ReturnType<typeof createInMemorySessionStoreDirectory<SessionRecord>>;
  readonly children: ReturnType<typeof createInMemorySessionStoreDirectory<SessionRecord>>;
  readonly store: ReturnType<typeof createInMemoryManagedAgentControlStore>;
  readonly sessionId: string;
};

export type ManagedTuiFixture = {
  readonly parent: { readonly sessionId: string };
  readonly destination?: { readonly sessionId: string };
  readonly presentation: Awaited<ReturnType<typeof createPresentationSession>>;
  readonly terminal: VirtualTerminal;
  readonly lifecycle: ReturnType<typeof createSessionLifecycle>;
  readonly store: ManagedTuiStorage["store"];
  readonly sessions: ManagedTuiStorage["sessions"];
  readonly children: ManagedTuiStorage["children"];
  readonly storage: ManagedTuiStorage;
  conversationText(): string;
  press(data: string, frame: string, absentText?: string): Promise<void>;
  openFirstAgent(handle?: string): Promise<void>;
  close(): Promise<void>;
  stop(): Promise<void>;
  waitForAttention(
    predicate: (items: readonly ManagedAttentionItem[]) => boolean,
  ): Promise<readonly ManagedAttentionItem[]>;
};

export async function startManagedTui(
  driver: ModelDriver,
  viewport: {
    readonly clipboard?: Parameters<typeof runTui>[0]["clipboard"];
    readonly preferences?: Parameters<typeof createPresentationSession>[0]["preferences"];
    readonly rows?: number;
    readonly columns?: number;
    readonly deadlineScheduler?: DeadlineScheduler;
    readonly draftPersistencePolicy?: "process_only" | "recoverable";
    readonly restore?: ManagedTuiStorage;
    readonly withDestination?: boolean;
    readonly initialPrompt?: string;
    readonly durableSessions?: boolean;
    readonly blankDraft?: boolean;
    readonly thinking?: boolean;
    readonly controlReceiptBarrier?: (
      command: ManagedControlCommand,
      receipt: ManagedControlReceipt,
    ) => Promise<void>;
    readonly settlementBarrier?: () => Promise<void>;
    readonly controlRecordBarrier?: (
      record: Awaited<ReturnType<ManagedTuiStorage["store"]["read"]>>[number],
    ) => Promise<void>;
    readonly childRecordBarrier?: (record: SessionRecord) => Promise<void>;
    readonly workspaceRoot?: string;
    readonly modelTargets?: ModelTargets;
    readonly contextProfile?: import("@adam-agent/agent").ContextProfile;
    readonly permissions?: NonNullable<Parameters<typeof createSessionLifecycle>[0]["permissions"]>;
    readonly webHttp?: Parameters<typeof createSessionLifecycle>[0]["webHttp"];
    readonly webSearchConfiguration?: Parameters<
      typeof createSessionLifecycle
    >[0]["webSearchConfiguration"];
    readonly planPolicyVersion?: "plan-policy.hybrid-delegation-v1";
  } = {},
): Promise<ManagedTuiFixture> {
  const stateRoot =
    viewport.restore?.stateRoot ?? (await mkdtemp(join(tmpdir(), "adam-fleet-ui-")));
  const workspaceRoot = viewport.workspaceRoot ?? process.cwd();
  const sessions =
    viewport.restore?.sessions ??
    (viewport.durableSessions
      ? createJsonlSessionStoreDirectory<SessionRecord>({ workspaceRoot, stateRoot })
      : createInMemorySessionStoreDirectory<SessionRecord>());
  const children =
    viewport.restore?.children ??
    (viewport.durableSessions
      ? createJsonlSessionStoreDirectory<SessionRecord>({
          workspaceRoot,
          stateRoot: join(stateRoot, "managed-children"),
        })
      : createInMemorySessionStoreDirectory<SessionRecord>());
  const store = viewport.restore?.store ?? createInMemoryManagedAgentControlStore();
  const thinking = viewport.thinking
    ? { thinkingCapability: createDirectDeepSeekThinkingCapability(identity) }
    : {};
  const modelTargets: ModelTargets = viewport.modelTargets ?? {
    async resolve() {
      return {
        identity,
        contextProfile: viewport.contextProfile ?? contextProfile,
        driver,
        ...thinking,
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity,
            contextProfile: viewport.contextProfile ?? contextProfile,
            ...thinking,
            readiness: { status: "available", credentialSource: "test" },
          },
        ],
      };
    },
  };
  let held = false;
  const acquire = async () => {
    if (held) throw new Error("Test project already has an owner");
    held = true;
    return {
      async release() {
        held = false;
      },
    };
  };
  const lifecycle = createSessionLifecycle({
    workspaceRoot,
    stateRoot,
    ...(viewport.preferences === undefined ? {} : { preferences: viewport.preferences }),
    ...(viewport.webHttp === undefined ? {} : { webHttp: viewport.webHttp }),
    ...(viewport.webSearchConfiguration === undefined
      ? {}
      : { webSearchConfiguration: viewport.webSearchConfiguration }),
    modelTargets,
    permissions:
      viewport.permissions ?? createPermissionPolicy({ allowedEffects: ["read", "delegate"] }),
    workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
    [sessionAutomaticTitlesEnabled]: false,
    [sessionStoreDirectory]: sessions,
    [sessionProjectLifecycleOwner]: {
      acquire,
      async run(operation) {
        const lease = await acquire();
        try {
          return await operation();
        } finally {
          await lease.release();
        }
      },
    },
    [sessionManagedControl]: {
      userRoleDirectory: join(stateRoot, "roles"),
      ...(viewport.planPolicyVersion === undefined
        ? {}
        : { planPolicyVersion: viewport.planPolicyVersion }),
      store,
      childSessionStores: children,
      ...(viewport.controlRecordBarrier === undefined
        ? {}
        : { [managedAgentRecordBarrier]: viewport.controlRecordBarrier }),
      ...(viewport.settlementBarrier === undefined
        ? {}
        : { [managedAgentSettlementBarrier]: viewport.settlementBarrier }),
      ...(viewport.childRecordBarrier === undefined
        ? {}
        : { [sessionRecordCommittedBarrier]: viewport.childRecordBarrier }),
    },
  });
  const parent =
    viewport.restore === undefined
      ? await lifecycle.create({ targetIdentity: identity, mode: "default" })
      : { sessionId: viewport.restore.sessionId };
  if (viewport.restore === undefined)
    await lifecycle.setSessionManualName({ sessionId: parent.sessionId, name: "Fleet fixture" });
  if (viewport.initialPrompt !== undefined) {
    await lifecycle.continue({
      sessionId: parent.sessionId,
      input: { text: viewport.initialPrompt },
    });
  }
  if (viewport.withDestination)
    await lifecycle.continue({
      sessionId: parent.sessionId,
      input: { text: "Seed the source Session." },
    });
  const destination = viewport.withDestination
    ? await lifecycle.create({ targetIdentity: identity })
    : undefined;
  if (destination !== undefined) {
    await lifecycle.setSessionManualName({
      sessionId: destination.sessionId,
      name: "Destination fixture",
    });
    await lifecycle.continue({
      sessionId: destination.sessionId,
      input: { text: "Seed the destination Session." },
    });
  }
  const presentation = await createPresentationSession({
    lifecycle,
    modelTargets,
    workspaceRoot,
    stateRoot,
    ...(viewport.preferences === undefined ? {} : { preferences: viewport.preferences }),
    ...(viewport.blankDraft ? { targetIdentity: identity } : { sessionId: parent.sessionId }),
    projectLabel: "Fleet fixture",
    draftPersistencePolicy: viewport.draftPersistencePolicy ?? "process_only",
    ...(viewport.controlReceiptBarrier === undefined
      ? {}
      : { [presentationManagedControlReceiptBarrier]: viewport.controlReceiptBarrier }),
    [presentationSessionRecordReader]: async (sessionId) =>
      (await (await sessions.open(sessionId))?.read()) ?? [],
  });
  const terminal = new VirtualTerminal({ columns: 80, rows: 32, ...viewport });
  let waitingForFrame = "initial frame";
  let shutdownStage = "not requested";
  onTestFailed(() =>
    console.error(
      `Fleet screen at failure (${waitingForFrame}; shutdown=${shutdownStage}; terminal running=${terminal.running()}):\n${terminal.lines().join("\n")}\nPending transition: ${JSON.stringify(presentation.getState().authoritative.managedTransition)}\nAttention: ${JSON.stringify(presentation.getState().managedAttention)}\nControl: ${JSON.stringify(presentation.getState().authoritative.managedControl?.threads.map((thread) => ({ handle: thread.handle, phase: thread.turn.phase, label: thread.turn.label, diagnostic: thread.turn.diagnostic, outcome: thread.turn.outcome, attention: thread.turn.attention, actions: thread.actions })))}`,
    ),
  );
  const running = runTui({
    terminal,
    presentation,
    ...(viewport.clipboard === undefined ? {} : { clipboard: viewport.clipboard }),
    ...(viewport.deadlineScheduler === undefined
      ? {}
      : { deadlineScheduler: viewport.deadlineScheduler }),
    closeRuntime: async () => {
      shutdownStage = "closing presentation";
      await presentation.close();
      shutdownStage = "closing lifecycle";
      await lifecycle.close();
      shutdownStage = "runtime closed";
    },
  });
  // The selected target remains visible when the minimum-height layout compresses the title.
  await terminal.waitForScreen(identity.targetId);
  const press = async (data: string, frame: string, absentText?: string) => {
    if (frame.trim().length === 0)
      throw new TypeError("A TUI action requires a visible completion condition.");
    waitingForFrame = frame;
    const offset = terminal.output().length;
    terminal.input(data);
    await terminal.waitForFrameAfter(frame, offset, absentText);
    waitingForFrame = "next test action";
  };
  return {
    parent,
    ...(destination === undefined ? {} : { destination }),
    presentation,
    terminal,
    lifecycle,
    store,
    sessions,
    children,
    storage: {
      stateRoot,
      sessions,
      children,
      store,
      sessionId: parent.sessionId,
    } satisfies ManagedTuiStorage,
    conversationText() {
      const lines = terminal.lines();
      const title = lines.find((line) => line.includes("Conversation ·"));
      if (title === undefined) return "";
      const left = title.indexOf("│");
      const right = title.lastIndexOf("│");
      return lines
        .filter((line) => line[left] === "│" && line[right] === "│")
        .map((line) => line.slice(left + 1, right))
        .join("\n");
    },
    async openFirstAgent(handle = "@explore-1") {
      await terminal.waitForScreen("Fleet");
      await press("\u001b[B", "● Main");
      await press("\u001b[B", `● ${handle}`);
      await press("\r", `Conversation · ${handle}`);
    },
    press,

    async close() {
      shutdownStage = "quit requested";
      if (terminal.running()) terminal.input("\u0011");
      try {
        await running;
      } finally {
        await rm(stateRoot, { recursive: true, force: true });
      }
    },
    async stop() {
      if (terminal.running()) terminal.input("\u0011");
      await running;
    },
    waitForAttention(predicate) {
      return new Promise((resolve) => {
        const check = () => {
          const items = presentation.getState().managedAttention ?? [];
          if (predicate(items)) {
            unsubscribe();
            resolve(items);
          }
        };
        const unsubscribe = presentation.subscribe(check);
        check();
      });
    },
  };
}
