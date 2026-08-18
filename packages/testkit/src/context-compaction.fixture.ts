import {
  type ContextProfile,
  createPermissionPolicy,
  createReadToolRegistry,
  createSessionLifecycle,
  type ModelDriver,
  ModelDriverError,
  type ModelTargetIdentity,
  type ModelTargets,
} from "@adam-agent/agent";

const workspaceRoot = requiredEnvironment("ADAM_AGENT_FIXTURE_WORKSPACE_ROOT");
const stateRoot = requiredEnvironment("ADAM_AGENT_FIXTURE_STATE_ROOT");
const sessionId = requiredEnvironment("ADAM_AGENT_FIXTURE_SESSION_ID");
const mode = requiredEnvironment("ADAM_AGENT_FIXTURE_MODE");

const targetIdentity: ModelTargetIdentity = {
  targetId: "fake.local",
  vendor: "adam",
  modelId: "fake",
  route: "direct",
  profileVersion: 1,
  certification: "certified",
};
const contextProfile: ContextProfile = {
  version: 1,
  contextWindowTokens: 20_000,
  maximumOutputTokens: 100,
  compactAtTokens: 700,
  postCompactTargetTokens: 600,
  retainedTargetTokens: 100,
  estimatorVersion: 1,
};
let ordinaryCall = 0;
let compactionCall = 0;

const model: ModelDriver = {
  async *stream(request) {
    if (request.tools.length === 0) {
      compactionCall += 1;
      if (mode === "started-hang" || mode === "started-hang-budget") {
        process.send?.({ type: "compaction-started" });
        await new Promise<void>(() => {});
        return;
      }
      yield {
        type: "text_delta",
        text: JSON.stringify({
          schemaVersion: 1,
          objective: "Continue after a real process restart.",
          constraints: [],
          progress: ["The read effect completed once."],
          unresolvedQuestions: [],
          failures: [],
          remainingVerification: [],
          nextSafeAction: "Complete the ordinary turn.",
        }),
      };
      yield { type: "usage", inputTokens: 520, outputTokens: 20 };
      yield { type: "finish", reason: "stop" };
      return;
    }
    ordinaryCall += 1;
    if (
      (mode === "started-hang" ||
        mode === "started-hang-budget" ||
        mode === "committed-event-hang" ||
        mode === "repository-activation-hang" ||
        mode === "two-compactions-complete") &&
      ordinaryCall === 1
    ) {
      yield { type: "usage", inputTokens: 30, outputTokens: 10 };
      yield { type: "tool_call_start", id: "read-process-context", name: "read_file" };
      yield {
        type: "tool_call_delta",
        id: "read-process-context",
        json:
          mode === "repository-activation-hang"
            ? '{"path":"nested/fact.txt"}'
            : '{"path":"context.txt"}',
      };
      yield { type: "tool_call_end", id: "read-process-context" };
      yield { type: "finish", reason: "tool_calls" };
      return;
    }
    if (mode === "two-compactions-complete" && ordinaryCall === 2) {
      yield { type: "usage", inputTokens: 35, outputTokens: 10 };
      yield { type: "tool_call_start", id: "read-process-context-second", name: "read_file" };
      yield {
        type: "tool_call_delta",
        id: "read-process-context-second",
        json: '{"path":"context.txt"}',
      };
      yield { type: "tool_call_end", id: "read-process-context-second" };
      yield { type: "finish", reason: "tool_calls" };
      return;
    }
    if (mode === "started-continue-overflow" && ordinaryCall === 1) {
      throw new ModelDriverError("invalid_request", "The resumed turn still overflows.", {
        cause: new Error("context length exceeded after process restart"),
        status: 400,
        providerCode: "context_length_exceeded",
        requestId: "resumed-overflow",
      });
    }
    if (mode === "reactive-complete" && ordinaryCall === 1) {
      throw new ModelDriverError("invalid_request", "The provider rejected the context length.", {
        cause: new Error("context length exceeded"),
        status: 400,
        providerCode: "context_length_exceeded",
        requestId: "real-process-overflow",
      });
    }
    const serialized = JSON.stringify(request.messages);
    if (mode === "committed-continue") {
      process.send?.({
        type: "checkpoint-request-observed",
        hasSummary: serialized.includes("<context-summary"),
        hasRawBulk: serialized.includes("PROCESS_RAW_CONTEXT_TAIL"),
      });
    }
    if (mode === "repository-activation-continue") {
      process.send?.({
        type: "repository-request-observed",
        hasFrozenRule: serialized.includes("Process nested rule."),
        hasReadResult: serialized.includes("process nested fact"),
      });
    }
    yield {
      type: "text_delta",
      text:
        mode === "started-continue"
          ? "Continued after interrupted compaction."
          : mode === "reactive-complete"
            ? "Reactive process compaction completed."
            : mode === "two-compactions-complete"
              ? "Two process compactions completed."
              : mode === "branch-first-checkpoint"
                ? "Branch continued from the first checkpoint."
                : mode === "repository-activation-continue"
                  ? "Repository activation recovered."
                  : "Continued from committed checkpoint.",
    };
    yield { type: "usage", inputTokens: 90, outputTokens: 10 };
    yield { type: "finish", reason: "stop" };
  },
};

const modelTargets: ModelTargets = {
  async resolve() {
    return { identity: targetIdentity, driver: model, contextProfile };
  },
  async snapshot() {
    return {
      targets: [
        {
          identity: targetIdentity,
          readiness: { status: "available", credentialSource: "test" },
          contextProfile,
        },
      ],
    };
  },
};
const lifecycle = createSessionLifecycle({
  modelTargets,
  stateRoot,
  workspaceRoot,
  tools: createReadToolRegistry({ workspaceRoot }),
  permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
});
if (mode === "committed-event-hang") {
  lifecycle.subscribe((event) => {
    if (event.type === "context_compaction_committed") {
      process.send?.({ type: "checkpoint-committed-before-swap" });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  });
}
if (mode === "repository-activation-hang") {
  lifecycle.subscribe((event) => {
    if (event.type === "repository_instructions_activated") {
      process.send?.({ type: "repository-activation-committed", revision: event.revision });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  });
}

if (mode === "inspect-only") {
  try {
    const inspected = await lifecycle.inspect({ sessionId });
    await sendAndDisconnect({ type: "context-inspected", inspected });
  } catch (error) {
    await sendAndDisconnect({
      type: "context-inspection-failed",
      code:
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "unknown",
    });
  }
} else if (mode === "branch-first-checkpoint") {
  const atSequence = Number(requiredEnvironment("ADAM_AGENT_FIXTURE_AT_SEQUENCE"));
  const child = await lifecycle.branch({ parentSessionId: sessionId, atSequence });
  const continued = await lifecycle.continue({
    sessionId: child.sessionId,
    input: { text: "Continue from the first checkpoint." },
  });
  await sendAndDisconnect({
    type: "context-branched",
    child,
    ordinaryCall,
    compactionCall,
    continued,
  });
} else {
  const continued = await lifecycle.continue({
    sessionId,
    ...(mode === "started-hang" ||
    mode === "started-hang-budget" ||
    mode === "committed-event-hang" ||
    mode === "repository-activation-hang" ||
    mode === "reactive-complete" ||
    mode === "two-compactions-complete"
      ? { input: { text: "Read context.txt and survive a real process restart." } }
      : {}),
    ...(mode === "started-hang-budget" ? { limits: { maxTokens: 10_000 } } : {}),
  });
  await sendAndDisconnect({
    type: "context-continued",
    mode,
    ordinaryCall,
    compactionCall,
    continued,
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
