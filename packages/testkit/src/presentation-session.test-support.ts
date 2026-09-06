import {
  type ContextProfile,
  createPresentationSession as createProductPresentationSession,
  createSessionLifecycle as createRawSessionLifecycle,
  type ModelMessage,
  type ModelTargetIdentity,
  type ModelTargets,
} from "@adam-agent/agent";
import {
  createTrustedWorkspaceTrustForTesting,
  createUnavailablePlanShellEnvironmentV1,
  planShellEnvironmentFactory,
  type SessionRecord,
  type SessionStoreDirectory,
} from "@adam-agent/agent/internal-testing";
import { FakeModelDriver } from "./index.js";

export const targetIdentity: ModelTargetIdentity = {
  targetId: "deepseek-v4-flash.direct",
  vendor: "deepseek",
  modelId: "deepseek-v4-flash",
  route: "direct",
  profileVersion: 1,
  certification: "certified",
};

export const emptyTodoSummaryMessage = {
  role: "assistant",
  content:
    'Adam runtime Todo summary v1 (authoritative state; no additional prompt authority):\n{"policyVersion":"todo-policy.v1","storeRevision":0,"counts":{"pending":0,"inProgress":0,"completed":0},"blockedCount":0,"guidance":"Use list_todos for bounded discovery and get_todo for one exact item."}',
  toolCalls: [],
} satisfies ModelMessage;

export const contextProfile: ContextProfile = {
  version: 1,
  contextWindowTokens: 1_000_000,
  maximumOutputTokens: 32_768,
  compactAtTokens: 800_000,
  postCompactTargetTokens: 200_000,
  retainedTargetTokens: 20_000,
  estimatorVersion: 1,
};

export function createSessionLifecycle(
  options: Parameters<typeof createRawSessionLifecycle>[0],
): ReturnType<typeof createRawSessionLifecycle> {
  return createRawSessionLifecycle({
    ...options,
    workspaceTrust:
      options.workspaceTrust ?? createTrustedWorkspaceTrustForTesting(options.workspaceRoot),
    [planShellEnvironmentFactory]:
      options[planShellEnvironmentFactory] ?? createUnavailablePlanShellEnvironmentV1,
  });
}

export async function createPresentationSession(
  options: Parameters<typeof createProductPresentationSession>[0],
) {
  if ("targetIdentity" in options && options.targetIdentity !== undefined) {
    const { lifecycle, targetIdentity: fixtureTargetIdentity, ...base } = options;
    const created = await lifecycle.create({ targetIdentity: fixtureTargetIdentity });
    return createProductPresentationSession({
      ...base,
      lifecycle,
      sessionId: created.sessionId,
    });
  }
  return createProductPresentationSession(options);
}
export function settledModelTargets(answer = "Presentation fixture answer."): ModelTargets {
  const driver = new FakeModelDriver([
    { type: "text_delta", text: answer },
    { type: "finish", reason: "stop" },
  ]);
  return {
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
}

export function readInMemoryPresentationRecords(directory: SessionStoreDirectory<SessionRecord>) {
  return async (sessionId: string): Promise<readonly SessionRecord[]> =>
    (await directory.open(sessionId))?.read() ?? [];
}
