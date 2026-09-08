import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createJsonlSessionStoreDirectory,
  createModelTargets,
  createPermissionPolicy,
  createPresentationPreferences,
  createWorkspaceTrust,
  type SessionRecord,
} from "@adam-agent/agent";
import { createJsonlManagedAgentControlStore } from "@adam-agent/agent/internal-testing";
import { createAdamCommandRegistryFromContributions } from "./command-registry.js";
import { createProductionProjectRuntime, projectRuntimeManagedControl } from "./project-runtime.js";
import { runTui } from "./tui-app.js";

const { ADAM_TEST_TERMINAL_PROCESS_MARKER: marker } = process.env;
if (marker === undefined) {
  throw new TypeError("The production TUI fixture requires its process marker.");
}
await writeFile(marker, `${process.pid}\n`, "utf8");
// biome-ignore lint/complexity/useLiteralKeys: ProcessEnv requires indexed access under strict TypeScript.
const modelResponse = process.env["ADAM_TEST_MODEL_RESPONSE"];
if (modelResponse !== undefined) {
  globalThis.fetch = async (_input, init) => {
    const { ADAM_TEST_REVIEW_REQUEST_MARKER: requestMarker, ADAM_TEST_REVIEW_STREAM: streaming } =
      process.env;
    if (requestMarker !== undefined) await appendFile(requestMarker, "request\n");
    if (streaming === "1") {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Partial review evidence before process interruption." }, finish_reason: null }], created: 1, model: "fixture", object: "chat.completion.chunk" })}\n\n`,
              ),
            );
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("Cancelled", "AbortError")),
              { once: true },
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" }, status: 200 },
      );
    }
    return new Response(
      [
        `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: modelResponse }, finish_reason: null }], created: 1, model: "fixture", object: "chat.completion.chunk", usage: null })}`,
        "",
        'data: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"created":1,"model":"fixture","object":"chat.completion.chunk","usage":null}',
        "",
        'data: {"id":"fixture","choices":[],"created":1,"model":"fixture","object":"chat.completion.chunk","usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      { headers: { "content-type": "text/event-stream" }, status: 200 },
    );
  };
}
const { ADAM_TEST_CONTROL_REVIEW: candidate } = process.env;
if (candidate !== "1") await import("./main.js");
else {
  // The candidate uses the same production owners; only this fixture can select it before cutover.
  const arguments_ = process.argv.slice(2);
  const stateRoot = arguments_[arguments_.indexOf("--state-root") + 1];
  const sessionId = arguments_[arguments_.indexOf("--resume") + 1];
  if (stateRoot === undefined || sessionId === undefined)
    throw new Error("Missing candidate fixture identity");
  const workspaceRoot = process.cwd();
  const environment = process.env;
  const runtime = await createProductionProjectRuntime({
    [projectRuntimeManagedControl]: {
      store: await createJsonlManagedAgentControlStore({ workspaceRoot, stateRoot }),
      childSessionStores: createJsonlSessionStoreDirectory<SessionRecord>({
        workspaceRoot,
        stateRoot: join(stateRoot, "managed-agent-sessions"),
      }),
      userRoleDirectory: join(stateRoot, "roles"),
    },
    environment,
    workspaceRoot,
    stateRoot,
    modelTargets: createModelTargets({ environment }),
    preferences: createPresentationPreferences({ environment }),
    workspaceTrust: createWorkspaceTrust({ environment, workspaceRoot }),
    permissions: createPermissionPolicy({
      allowedEffects: ["read"],
      askedEffects: ["write", "execute", "network", "delegate", "administrative"],
    }),
    extensionPermissions: createPermissionPolicy({ allowedEffects: ["execute"] }),
    projectLabel: "Public Eve PTY",
    reservedCommandNames: [],
    resumeSessionId: sessionId,
  });
  try {
    const presentation = await runtime.createPresentation({ sessionId });
    await runTui({
      presentation,
      mouse: true,
      commandRegistry: createAdamCommandRegistryFromContributions(runtime.contributions),
      closeRuntime: () => runtime.close(),
    });
  } finally {
    await runtime.close();
  }
}
