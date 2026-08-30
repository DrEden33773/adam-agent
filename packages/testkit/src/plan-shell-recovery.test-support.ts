import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCodingToolRegistry,
  type ModelMessage,
  type ModelTargets,
  type RuntimeEvent,
  type ToolResult,
} from "@adam-agent/agent";
import {
  assessPlanCommandExecutionV1,
  digestPromptRequestV1,
  type PlanShellEnvironmentFactory,
  planShellEnvironmentFactory,
  type SessionRecord,
  submitPlanToolDefinitionV1,
} from "@adam-agent/agent/internal-testing";
import { createInMemorySessionLifecycleHarness, FakeModelDriver } from "./index.js";
import {
  sessionLifecycleBasePrompt as basePrompt,
  sessionLifecycleSkillUsagePrompt as skillUsagePrompt,
  sessionLifecycleTargetIdentity as targetIdentity,
} from "./session-lifecycle.test-support.js";

const contextProfile = {
  version: 1 as const,
  contextWindowTokens: 1_000_000,
  maximumOutputTokens: 32_768,
  compactAtTokens: 800_000,
  postCompactTargetTokens: 200_000,
  retainedTargetTokens: 20_000,
  estimatorVersion: 1 as const,
};

export type PlanShellRecoveryFixtureResult = {
  readonly resume:
    | { readonly status: "rejected"; readonly code: string | undefined }
    | {
        readonly status: "ready";
        readonly snapshotStatus: "idle" | "interrupted" | "settled";
        readonly runResult: unknown;
      };
  readonly continuationResult?: unknown;
  readonly secondResume?: {
    readonly snapshotStatus: "idle" | "interrupted" | "settled";
    readonly runResult: unknown;
  };
  readonly publicEvents: readonly RuntimeEvent[];
  readonly observedToolResult?: ToolResult;
  readonly providerCalls: number;
};

export async function exercisePlanShellRecoveryFixture(options: {
  readonly shellEnvironmentFactory: PlanShellEnvironmentFactory;
  readonly command: string;
  readonly decision: "allow" | "deny";
  readonly assessmentMatches?: boolean;
  readonly omitPermissionRequest?: boolean;
  readonly started?: boolean;
}): Promise<PlanShellRecoveryFixtureResult> {
  const assessmentMatches = options.assessmentMatches ?? true;
  const omitPermissionRequest = options.omitPermissionRequest ?? false;
  const started = options.started ?? false;
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-plan-shell-recovery-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const call = {
    id: "plan-shell-recovery",
    name: "run_shell",
    argumentsJson: JSON.stringify({ command: options.command }),
  } as const;
  const runId = "123e4567-e89b-42d3-a456-426614176010";
  let providerCalls = 0;
  let observedToolResult: ToolResult | undefined;
  const driver = new FakeModelDriver((request) => {
    providerCalls += 1;
    const toolMessage = request.messages.findLast(
      (message): message is Extract<ModelMessage, { readonly role: "tool" }> =>
        message.role === "tool" && message.callId === call.id,
    );
    observedToolResult = toolMessage?.result;
    return [
      { type: "text_delta", text: "Recovered the exact Plan shell boundary." },
      { type: "finish", reason: "stop" },
    ];
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
  const harness = createInMemorySessionLifecycleHarness();
  const tools = createCodingToolRegistry({ workspaceRoot });
  const warm = harness.createLifecycle({
    modelTargets,
    stateRoot,
    tools,
    workspaceRoot,
    [planShellEnvironmentFactory]: options.shellEnvironmentFactory,
  });
  let cold: ReturnType<typeof harness.createLifecycle> | undefined;
  let secondCold: ReturnType<typeof harness.createLifecycle> | undefined;

  try {
    const created = await warm.create({ targetIdentity });
    const entered = await warm.enterPlan({ sessionId: created.sessionId });
    const plan = entered.plan;
    const shellTool = tools.resolve("run_shell");
    if (
      plan?.shellEnvironment === undefined ||
      plan.gitPolicyVersion !== "git-auto-policy.v1" ||
      plan.gitPolicyDigest === undefined ||
      shellTool === undefined ||
      entered.promptContext === undefined
    ) {
      throw new Error("Expected the hybrid Plan shell authority.");
    }
    const assessment = await assessPlanCommandExecutionV1({
      rawCommand: options.command,
      shellEnvironment: plan.shellEnvironment,
      workspaceRoot,
    });
    if (assessment.status !== "assessed") {
      throw new Error("Expected one bounded Plan shell assessment.");
    }
    const subject = {
      type: "plan_command" as const,
      command: options.command,
      cwd: "." as const,
      planCycleId: plan.cycleId,
      planPolicyVersion: "plan-policy.hybrid-v1" as const,
      shellPolicyVersion: "plan-shell-policy.v1" as const,
      shellEnvironmentVersion: "plan-shell-env.v1" as const,
      shellEnvironmentDigest: plan.shellEnvironment.digest,
      toolProfileDigest: plan.eligibleToolProfile.digest,
      gitPolicyVersion: plan.gitPolicyVersion,
      gitPolicyDigest: plan.gitPolicyDigest,
      assessment: {
        version: 1 as const,
        disposition: assessment.disposition,
        reasons: assessment.reasons,
        digest: assessmentMatches ? assessment.digest : (`sha256:${"0".repeat(64)}` as const),
      },
    };
    const planToolNames = new Set(
      plan.eligibleToolProfile.definitions.map((definition) => definition.name),
    );
    const requestTools = tools
      .definitions()
      .filter((definition) => planToolNames.has(definition.name))
      .concat(submitPlanToolDefinitionV1);
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created Plan session store.");
    }
    const records = [
      {
        schemaVersion: 3,
        record: {
          type: "logical_run_started",
          runId,
          userMessage: "Recover one exact Plan diagnostic.",
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Recover one exact Plan diagnostic." },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: {
            version: 1,
            assemblyIdentityDigest: entered.promptContext.assemblyIdentityDigest,
            requestProjectionDigest: digestPromptRequestV1(
              [
                { role: "system", content: basePrompt },
                { role: "developer", content: skillUsagePrompt },
                {
                  role: "assistant",
                  content:
                    'Adam runtime Todo summary v1 (authoritative state; no additional prompt authority):\n{"policyVersion":"todo-policy.v1","storeRevision":0,"counts":{"pending":0,"inProgress":0,"completed":0},"blockedCount":0,"guidance":"Use list_todos for bounded discovery and get_todo for one exact item."}',
                  toolCalls: [],
                },
                { role: "user", content: "Recover one exact Plan diagnostic." },
              ],
              requestTools,
            ),
          },
        },
      },
      {
        schemaVersion: 3,
        record: { type: "runtime_event", runId, event: { type: "model_message_started" } },
      },
      {
        schemaVersion: 3,
        record: {
          type: "model_response_completed",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          response: {
            text: "",
            toolCalls: [call],
            toolIntents: [
              {
                callId: call.id,
                name: call.name,
                argumentsDigest: `sha256:${createHash("sha256")
                  .update(call.argumentsJson)
                  .digest("hex")}`,
                effect: "execute",
                definitionDigest: shellTool.definitionDigest,
                replay: "never",
              },
            ],
            finishReason: "tool_calls",
          },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_message_completed", text: "" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "tool_requested", callId: call.id, name: call.name },
        },
      },
      ...(!omitPermissionRequest
        ? [
            {
              schemaVersion: 3,
              record: {
                type: "runtime_event",
                runId,
                event: {
                  type: "tool_permission_requested",
                  requestId: `${runId}:${call.id}`,
                  callId: call.id,
                  name: call.name,
                  effect: "execute",
                  scope: "call",
                  subject,
                },
              },
            } as const,
          ]
        : []),
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: {
            type: "tool_permission_decided",
            ...(omitPermissionRequest ? {} : { requestId: `${runId}:${call.id}` }),
            callId: call.id,
            name: call.name,
            decision: options.decision,
            effect: "execute",
            scope: "call",
            subject,
          },
        },
      },
      ...(started
        ? [
            {
              schemaVersion: 3,
              record: {
                type: "runtime_event",
                runId,
                event: { type: "tool_started", callId: call.id, name: call.name },
              },
            } as const,
          ]
        : []),
    ] satisfies readonly Omit<Extract<SessionRecord, { readonly schemaVersion: 3 }>, "sequence">[];
    for (const [index, record] of records.entries()) {
      await store.append({
        ...record,
        sequence: entered.lastSequence + index + 1,
      } as SessionRecord);
    }
    await warm.close();
    cold = harness.createLifecycle({
      modelTargets,
      stateRoot,
      tools,
      workspaceRoot,
      [planShellEnvironmentFactory]: options.shellEnvironmentFactory,
    });
    const publicEvents: RuntimeEvent[] = [];
    cold.subscribe((event) => {
      publicEvents.push(event);
      if (event.type === "tool_permission_requested") {
        cold?.decidePermission({ requestId: event.requestId, decision: "deny" });
      }
    });

    let resumed: Extract<PlanShellRecoveryFixtureResult["resume"], { readonly status: "ready" }>;
    try {
      const result = await cold.resume({ sessionId: created.sessionId });
      if (result.snapshot.schemaVersion !== 3) {
        throw new Error("Expected one current session recovery snapshot.");
      }
      resumed = {
        status: "ready" as const,
        snapshotStatus: result.snapshot.status,
        runResult: result.snapshot.run?.result,
      };
    } catch (error) {
      return {
        resume: {
          status: "rejected" as const,
          code:
            typeof error === "object" && error !== null && "code" in error
              ? String(error.code)
              : undefined,
        },
        publicEvents,
        providerCalls,
      };
    }
    const continuationResult =
      resumed.snapshotStatus === "interrupted"
        ? (await cold.continue({ sessionId: created.sessionId })).result
        : undefined;
    let secondResume: PlanShellRecoveryFixtureResult["secondResume"];
    if (continuationResult !== undefined) {
      await cold.close();
      cold = undefined;
      secondCold = harness.createLifecycle({
        modelTargets,
        stateRoot,
        tools,
        workspaceRoot,
        [planShellEnvironmentFactory]: options.shellEnvironmentFactory,
      });
      const second = await secondCold.resume({ sessionId: created.sessionId });
      if (second.snapshot.schemaVersion !== 3) {
        throw new Error("Expected one current settled recovery snapshot.");
      }
      secondResume = {
        snapshotStatus: second.snapshot.status,
        runResult: second.snapshot.run?.result,
      };
    }
    return {
      resume: resumed,
      ...(continuationResult === undefined ? {} : { continuationResult }),
      ...(secondResume === undefined ? {} : { secondResume }),
      publicEvents,
      ...(observedToolResult === undefined ? {} : { observedToolResult }),
      providerCalls,
    };
  } finally {
    await warm.close();
    await cold?.close();
    await secondCold?.close();
    await rm(testRoot, { recursive: true, force: true });
  }
}
