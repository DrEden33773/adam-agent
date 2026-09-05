import { createHash } from "node:crypto";
import { join } from "node:path";
import { AgentSession, createPermissionPolicy, ModelDriverError } from "@adam-agent/agent";
import {
  createJsonlManagedAgentControlStore,
  createJsonlSessionStoreDirectory,
  createManagedAgentControl,
  createProjectExecutionDomain,
  createProjectLifecycleOwner,
  createPromptContextV1,
  managedAgentRecordBarrier,
  managedAgentRequestBoundary,
  managedControlMainRequestBoundary,
  type SessionStore,
  sessionDurableContext,
  sessionRecordCommittedBarrier,
} from "@adam-agent/agent/internal-testing";

const { ADAM_CONTROL_FIXTURE_ROOT: workspaceRoot, ADAM_CONTROL_FIXTURE_PHASE: phase } = process.env;
if (workspaceRoot === undefined || phase === undefined)
  throw new Error("Missing fixture configuration.");
const stateRoot = join(workspaceRoot, "state");
const domain = createProjectExecutionDomain({
  lifecycleOwner: createProjectLifecycleOwner({ workspaceRoot, stateRoot }),
});
const parentSessionId = "123e4567-e89b-42d3-a456-426614174601";
let expireInactivity: (() => void) | undefined;
const parentStore =
  phase === "main_receipt" || phase === "consumed"
    ? await createJsonlSessionStoreDirectory({
        workspaceRoot,
        stateRoot: join(workspaceRoot, "parents"),
      }).create(parentSessionId)
    : undefined;
const controlOptions: Parameters<typeof createManagedAgentControl>[0] = {
  parentSessionId: "123e4567-e89b-42d3-a456-426614174601",
  projectId: `sha256:${createHash("sha256").update(workspaceRoot).digest("hex")}`,
  workspaceRoot,
  targetIdentity: {
    targetId: "deepseek-v4-flash.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-flash",
    route: "direct",
    profileVersion: 1,
    certification: "certified",
  },
  contextProfile: {
    version: 1,
    contextWindowTokens: 128_000,
    maximumOutputTokens: 4096,
    compactAtTokens: 96_000,
    postCompactTargetTokens: 32_000,
    retainedTargetTokens: 8000,
    estimatorVersion: 1,
  },
  model: {
    async *stream(request) {
      if (phase === "stalled_terminal") {
        yield { type: "text_delta", text: "Partial crash evidence." };
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => resolve(), { once: true });
          expireInactivity?.();
        });
        return;
      }
      if (phase === "tool_started") {
        yield { type: "tool_call_start", id: "read-crash", name: "read_file" };
        yield { type: "tool_call_delta", id: "read-crash", json: '{"path":"evidence.txt"}' };
        yield { type: "tool_call_end", id: "read-crash" };
        yield { type: "usage", inputTokens: 20, outputTokens: 5 };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "Crash-retained evidence." };
      if (phase === "provider_attempt_interrupted")
        throw new ModelDriverError("transport", "External fixture disconnected.", {
          cause: undefined,
        });
      yield { type: "usage", inputTokens: 20, outputTokens: 5 };
      yield { type: "finish", reason: "stop" };
    },
  },
  permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
  executionDomain: domain,
  ...(phase === "stalled_terminal"
    ? {
        inactivityScheduler: {
          schedule(_milliseconds: number, expire: () => void) {
            expireInactivity = expire;
            return { cancel() {} };
          },
        },
      }
    : {}),
  store: await createJsonlManagedAgentControlStore({ workspaceRoot, stateRoot }),
  childSessionStores: createJsonlSessionStoreDirectory({
    workspaceRoot,
    stateRoot: join(workspaceRoot, "children"),
  }),
  ...(parentStore === undefined ? {} : { parentSessionStore: parentStore }),
  [managedAgentRecordBarrier]: async (record) => {
    if (record.event.type !== (phase.startsWith("cancel_") ? phase.slice(7) : phase)) return;
    process.send?.({ phase, threadId: record.threadId, turnId: record.turnId });
    await new Promise<void>(() => {});
  },
  [sessionRecordCommittedBarrier]: async (record) => {
    if (record.schemaVersion !== 3) return;
    const kind =
      record.record.type === "runtime_event" ? record.record.event.type : record.record.type;
    if (kind !== (phase === "stalled_terminal" ? "session_settled" : phase)) return;
    const records = await (
      await createJsonlManagedAgentControlStore({ workspaceRoot, stateRoot })
    ).read();
    const admission = records[0];
    process.send?.({ phase, threadId: admission?.threadId, turnId: admission?.turnId });
    await new Promise<void>(() => {});
  },
};
const control = createManagedAgentControl(controlOptions);
const observation = new AbortController();
const childCompleted =
  parentStore === undefined
    ? undefined
    : (async () => {
        for await (const frame of control.observe({ parentSessionId, signal: observation.signal }))
          if (frame.snapshot.completions.length > 0) return;
      })();
if (phase.startsWith("cancel_")) {
  const admission = (await controlOptions.store.read())[0];
  if (admission === undefined) throw new Error("Missing cancelled admission.");
  await control.dispatch({
    type: "cancel_turn",
    parentSessionId,
    threadId: admission.threadId,
    expectedTurnId: admission.turnId,
  });
} else
  await control.dispatch({
    type: "start_thread",
    parentSessionId: "123e4567-e89b-42d3-a456-426614174601",
    role: "builtin:explore",
    task: "Retain crash evidence.",
    description: "Crash evidence",
  });
if (parentStore !== undefined) {
  await childCompleted;
  observation.abort();
  const claim = await domain.claimScope({
    kind: "main_run",
    sessionId: parentSessionId,
    identity: "main-request",
  });
  const promptContext = createPromptContextV1(undefined);
  await parentStore.append({
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      recordVersion: 2,
      sessionId: parentSessionId,
      projectId: controlOptions.projectId,
      targetIdentity: controlOptions.targetIdentity,
      contextProfile: controlOptions.contextProfile,
      promptContext,
    },
  });
  const dependencies = {
    model: controlOptions.model,
    contextProfile: controlOptions.contextProfile,
    store: parentStore as SessionStore,
    [sessionDurableContext]: {
      nextSequence: 2,
      sessionId: parentSessionId,
      projectId: controlOptions.projectId,
      targetIdentity: controlOptions.targetIdentity,
      promptContext,
    },
    [managedAgentRequestBoundary]: managedControlMainRequestBoundary(control, parentSessionId),
    [sessionRecordCommittedBarrier]: async (
      record: import("@adam-agent/agent/internal-testing").SessionRecord,
    ) => {
      if (
        phase !== "main_receipt" ||
        record.schemaVersion !== 3 ||
        record.record.type !== "provider_attempt_started"
      )
        return;
      const admission = (await controlOptions.store.read())[0];
      process.send?.({ phase, threadId: admission?.threadId, turnId: admission?.turnId });
      await new Promise<void>(() => {});
    },
  };
  await new AgentSession(dependencies).run({ text: "Use the pending completion." });
  await claim.release();
}
