import { rename, unlink } from "node:fs/promises";

const {
  createModelTargets,
  createPermissionPolicy,
  createReadToolRegistry,
  createSessionLifecycle,
} = await import("@adam-agent/agent");
const { createCodingToolRegistryForTesting, sessionAutomaticTitlesEnabled } = await import(
  "@adam-agent/agent/internal-testing"
);

const workspaceRoot = requiredEnvironment("ADAM_AGENT_FIXTURE_WORKSPACE_ROOT");
const stateRoot = requiredEnvironment("ADAM_AGENT_FIXTURE_STATE_ROOT");
const sessionId = requiredEnvironment("ADAM_AGENT_FIXTURE_SESSION_ID");
const { ADAM_AGENT_FIXTURE_MODE: configuredMode } = process.env;
const mode = configuredMode ?? "provider-hang";
let providerRequests = 0;

const modelTargets = createModelTargets({
  environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
  fetch: async () => {
    providerRequests += 1;
    if (mode === "safe-read-then-hang" && providerRequests === 1) {
      return eventStream(readToolStream());
    }
    if (mode === "patch-rename-then-hang") {
      return eventStream(patchToolStream());
    }
    if (mode === "branch-child-complete") {
      return eventStream(answerStream());
    }
    process.send?.("provider-started");
    return new Promise<Response>(() => {});
  },
});

const lifecycle = createSessionLifecycle({
  [sessionAutomaticTitlesEnabled]: false,
  modelTargets,
  stateRoot,
  workspaceRoot,
  ...(mode === "safe-read-then-hang"
    ? {
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      }
    : mode === "patch-rename-then-hang"
      ? {
          tools: createCodingToolRegistryForTesting({
            stateRoot,
            workspaceRoot,
            patchFileSystem: {
              async rename(source, destination) {
                await rename(source, destination);
                if (destination.endsWith("destination.txt")) {
                  process.send?.("patch-renamed");
                  await new Promise<void>(() => {});
                }
              },
              unlink,
            },
          }),
          permissions: createPermissionPolicy({ allowedEffects: ["write"] }),
        }
      : {}),
});
if (mode === "branch-child-complete") {
  const atSequence = Number(requiredEnvironment("ADAM_AGENT_FIXTURE_AT_SEQUENCE"));
  const child = await lifecycle.branch({ parentSessionId: sessionId, atSequence });
  const continued = await lifecycle.continue({
    sessionId: child.sessionId,
    input: { text: "Write independently in the child" },
  });
  await sendAndDisconnect({ type: "branch-child-completed", child, continued });
} else if (mode === "inspect-only") {
  try {
    const resumed = await lifecycle.resume({ sessionId });
    await sendAndDisconnect({ type: "session-inspected", resumed });
  } catch (error) {
    await sendAndDisconnect({
      type: "session-inspection-failed",
      code:
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "unknown",
    });
  }
} else {
  await lifecycle.continue({
    sessionId,
    input: {
      text: mode === "patch-rename-then-hang" ? "Move the source file" : "Read the project",
    },
  });
}

function eventStream(stream: string): Response {
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
    status: 200,
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

function readToolStream(): string {
  return `data: {"id":"read-before-crash","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"reasoning_content":"Read first.","tool_calls":[{"index":0,"id":"read-before-crash","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}

data: [DONE]

`;
}

function patchToolStream(): string {
  return `data: {"id":"patch-before-crash","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"patch-before-crash","type":"function","function":{"name":"edit_file","arguments":"{\\"operations\\":[{\\"kind\\":\\"move\\",\\"from\\":\\"source.txt\\",\\"to\\":\\"destination.txt\\"}]}"}}]},"finish_reason":"tool_calls"}]}

data: [DONE]

`;
}

function answerStream(): string {
  return `data: {"id":"branch-answer","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"content":"Child completed."},"finish_reason":"stop"}]}

data: [DONE]

`;
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
