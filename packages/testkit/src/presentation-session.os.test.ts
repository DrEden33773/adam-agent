import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ContextProfile,
  createPresentationSession,
  createSessionLifecycle as createRawSessionLifecycle,
  type ModelTargetIdentity,
  type ModelTargets,
} from "@adam-agent/agent";
import {
  createTrustedWorkspaceTrustForTesting,
  openJsonlSessionStore,
  type SessionRecord,
  sessionLogicalRunStartedBarrier,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { FakeModelDriver } from "./index.js";

const targetIdentity: ModelTargetIdentity = {
  targetId: "deepseek-v4-flash.direct",
  vendor: "deepseek",
  modelId: "deepseek-v4-flash",
  route: "direct",
  profileVersion: 1,
  certification: "certified",
};

const contextProfile: ContextProfile = {
  version: 1,
  contextWindowTokens: 1_000_000,
  maximumOutputTokens: 32_768,
  compactAtTokens: 800_000,
  postCompactTargetTokens: 200_000,
  retainedTargetTokens: 20_000,
  estimatorVersion: 1,
};

function createSessionLifecycle(
  options: Parameters<typeof createRawSessionLifecycle>[0],
): ReturnType<typeof createRawSessionLifecycle> {
  return createRawSessionLifecycle({
    ...options,
    workspaceTrust:
      options.workspaceTrust ?? createTrustedWorkspaceTrustForTesting(options.workspaceRoot),
  });
}

test("PresentationSession publishes admission only after the durable logical-input record", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-draft-durable-input-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver(() => {
    throw new Error("The model must not start past the injected durability boundary.");
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
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
    [sessionLogicalRunStartedBarrier]: {
      async afterDurableRecord() {
        throw new Error("Injected interruption after durable logical input.");
      },
    },
  });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      openProject: true,
      projectLabel: "workspace",
      stateRoot,
      workspaceRoot,
    });
    await presentation.dispatch({ type: "create_session", targetId: targetIdentity.targetId });

    await expect(
      presentation.dispatch({
        type: "submit_draft_prompt",
        text: "Keep the durable logical input",
        skills: [],
        thinkingSelection: null,
      }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });

    const sessionId = presentation.getState().authoritative.active?.session.id;
    if (sessionId === undefined) {
      throw new Error("The durable admission boundary must publish its resumable session.");
    }
    const store = await openJsonlSessionStore<SessionRecord>({
      sessionId,
      stateRoot,
      workspaceRoot,
    });
    expect(await store.read()).toEqual([
      expect.objectContaining({ record: expect.objectContaining({ type: "session_genesis" }) }),
      expect.objectContaining({
        record: expect.objectContaining({
          type: "logical_run_started",
          userMessage: "Keep the durable logical input",
        }),
      }),
    ]);
    await expect(lifecycle.listProjectSessions()).resolves.toMatchObject({
      items: [{ sessionId }],
    });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});
