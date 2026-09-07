import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createJsonlSessionStoreDirectory,
  createModelTargets,
  createPermissionPolicy,
  createPresentationPreferences,
  createWorkspaceTrust,
  type SessionRecord,
} from "@adam-agent/agent";
import { createJsonlManagedAgentControlStore } from "@adam-agent/agent/internal-testing";
import type { PresentationSession } from "@adam-agent/presentation";
import { expect, test } from "vitest";
import { createProductionProjectRuntime, projectRuntimeManagedControl } from "./project-runtime.js";

const exec = promisify(execFile);

async function observe(presentation: PresentationSession, predicate: () => boolean) {
  const reached = Promise.withResolvers<void>();
  const check = () => {
    if (predicate()) reached.resolve();
  };
  const unsubscribe = presentation.subscribe(check);
  const guard = setTimeout(
    () => reached.reject(new Error("Missing production review projection")),
    5000,
  );
  try {
    check();
    await reached.promise;
  } finally {
    clearTimeout(guard);
    unsubscribe();
  }
}

test("the real candidate ProjectRuntime composes a non-Eve managed review through Lifecycle, public package codecs, JSONL and the provider adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-x0-runtime-"));
  let runtime: Awaited<ReturnType<typeof createProductionProjectRuntime>> | undefined;
  try {
    const workspaceRoot = join(root, "workspace");
    const stateRoot = join(root, "state");
    const packageRoot = join(root, "extension");
    const configRoot = join(root, "config");
    await mkdir(workspaceRoot);
    await exec("git", ["init", "--quiet", workspaceRoot]);
    await writeFile(join(workspaceRoot, "evidence.txt"), "changed evidence\n");
    await mkdir(join(packageRoot, "node_modules", "@adam-agent"), { recursive: true });
    await symlink(
      fileURLToPath(new URL("../../../packages/extension-api", import.meta.url)),
      join(packageRoot, "node_modules", "@adam-agent", "extension-api"),
    );
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@fixture/runtime-review",
        version: "1.0.0",
        type: "module",
        adamAgent: {
          id: "fixture.runtime-review",
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
              id: "fixture.runtime-review",
              command: {
                id: "fixture.review",
                version: 1,
                name: "fixturecheck",
                title: "Fixture review",
              },
              inputSource: { id: "project_changes", version: 1 },
              input: { id: "adam.project-change-snapshot", version: 1 },
              output: { id: "fixture.output", version: 1 },
              progress: { id: "fixture.progress", version: 1 },
              managedOutput: { id: "fixture.verdict", version: 1 },
            },
          ],
        },
      }),
    );
    await writeFile(
      join(packageRoot, "runtime.js"),
      `
import { extensionProjectChangeSnapshotCodec, extensionManagedReviewTerminalCodec } from "@adam-agent/extension-api";
export function activate(context) {
  const codec = id => ({ id, version: 1, decode: value => ({ ok: true, value }), encode: value => ({ ok: true, value }) });
  context.registerOperation({ id: "fixture.runtime-review", input: extensionProjectChangeSnapshotCodec, output: codec("fixture.output"), progress: codec("fixture.progress"), managedOutput: { ...codec("fixture.verdict"), decode: value => value?.verdict === "verified" ? { ok: true, value } : { ok: false, issues: [] } },
    async execute(input, operation) {
      const artifact = await operation.capabilities["adam.artifact.publish@1"].publish({ bytes: new TextEncoder().encode(JSON.stringify(input)), contract: { id: "fixture.evidence", version: 1 }, mediaType: "application/json" });
      const decoded = extensionManagedReviewTerminalCodec.decode(await operation.capabilities["adam.managed-review@1"].review({ evidence: [{ type: "artifact", artifact }], instruction: "Review immutable capture and return JSON.", outputContract: { id: "fixture.verdict", version: 1 } }));
      if (!decoded.ok || decoded.value.status !== "completed" || decoded.value.receipt.target.targetId !== "deepseek-v4-flash-vision-exp.direct") throw new Error("Invalid resolved review result");
      await operation.progress("fixture-review-codec-verified"); return { verified: true };
    }
  });
}
`,
    );
    await mkdir(join(configRoot, "adam-agent"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(configRoot, "adam-agent", "extensions.json"),
      JSON.stringify({
        schemaVersion: 1,
        extensions: [
          {
            enabled: true,
            extensionId: "fixture.runtime-review",
            grants: [
              { id: "adam.artifact.publish@1", version: "^1.0.0" },
              { id: "adam.managed-review@1", version: "^1.0.0" },
            ],
            packageName: "@fixture/runtime-review",
            packageRoot,
            packageVersion: "1.0.0",
          },
        ],
      }),
      { mode: 0o600 },
    );
    const environment = { XDG_CONFIG_HOME: configRoot, DEEPSEEK_API_KEY: "fixture-no-network" };
    const workspaceTrust = createWorkspaceTrust({ environment, workspaceRoot });
    const trust = await workspaceTrust.load();
    if (trust.projectId === null) throw new Error("Missing fixture project identity");
    await workspaceTrust.setTrusted({ projectId: trust.projectId, trusted: true });
    const requests: { readonly tools?: readonly unknown[]; readonly input?: unknown }[] = [];
    runtime = await createProductionProjectRuntime({
      [projectRuntimeManagedControl]: {
        store: await createJsonlManagedAgentControlStore({ workspaceRoot, stateRoot }),
        childSessionStores: createJsonlSessionStoreDirectory<SessionRecord>({
          workspaceRoot,
          stateRoot: join(stateRoot, "children"),
        }),
        userRoleDirectory: join(root, "roles"),
      },
      environment,
      workspaceRoot,
      stateRoot,
      workspaceTrust,
      projectLabel: "X0 fixture",
      reservedCommandNames: [],
      preferences: createPresentationPreferences({ environment }),
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      extensionPermissions: createPermissionPolicy({ allowedEffects: ["execute"] }),
      modelTargets: createModelTargets({
        environment,
        fetch: async (_input, init) => {
          const body = JSON.parse(String(init?.body));
          requests.push(body);
          const text = JSON.stringify(body.input).includes("Review immutable capture")
            ? '{"verdict":"verified"}'
            : "Origin ready";
          return new Response(
            `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5 } } })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      }),
    });
    expect(runtime.extensionAvailability.rejectedCount).toBe(0);
    const presentation = await runtime.createPresentation({ openProject: true });
    await presentation.dispatch({
      type: "create_session",
      targetId: "deepseek-v4-flash-vision-exp.direct",
    });
    const originReady = observe(
      presentation,
      () => presentation.getState().authoritative.active?.session.status === "settled",
    );
    expect(
      await presentation.dispatch({
        type: "submit_draft_prompt",
        text: "Initialize the review origin.",
        skills: [],
        thinkingSelection: null,
      }),
    ).toMatchObject({ status: "admitted" });
    await originReady;
    const sessionId = presentation.getState().authoritative.active?.session.id;
    if (sessionId === undefined) throw new Error("Missing origin Session");
    const reviewed = observe(
      presentation,
      () =>
        presentation
          .getState()
          .authoritative.active?.linkedOperations.some(
            (operation) => !["running", "cancel_requested"].includes(operation.status),
          ) === true,
    );
    expect(
      await presentation.dispatch({
        type: "start_project_changes",
        sessionId,
        command: { id: "fixture.review", version: 1 },
      }),
    ).toMatchObject({ status: "admitted" });
    await reviewed;
    expect(presentation.getState().authoritative.active?.linkedOperations[0]).toMatchObject({
      status: "completed",
      progress: { summary: "fixture-review-codec-verified" },
    });
    const reviewRequests = requests.filter((request) =>
      JSON.stringify(request.input).includes("Review immutable capture"),
    );
    expect(reviewRequests).toHaveLength(1);
    expect(reviewRequests[0]?.tools).toBeUndefined();
    expect(JSON.stringify(reviewRequests[0]?.input)).toContain("changed evidence");
    expect(requests.filter((request) => (request.tools?.length ?? 0) > 0)).toHaveLength(1);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
