import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { access, mkdir, watch, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ContextProfile,
  createExtensionHost,
  createFileArtifactStore,
  createInMemoryOperationStore,
  createPermissionPolicy,
  createPresentationPreferences,
  createPresentationSession,
  createSessionLifecycle,
  createWorkspaceTrust,
  type ModelDriver,
  ModelDriverError,
  type ModelTargetIdentity,
  type ModelTargets,
  type WorkspaceTrustController,
} from "@adam-agent/agent";
import {
  createTrustedWorkspaceTrustForTesting,
  mcpCloseConfirmation,
  type PresentationArtifactReadBarrier,
  planApprovalIntentBarrier,
  preparedDirectDeepSeekV2ContextProfile,
  presentationArtifactReadBarrier,
  presentationHistoryPageSize,
  turnComposerStageBarrier,
} from "@adam-agent/agent/internal-testing";
import type { PresentationSession } from "@adam-agent/presentation";
import { ProcessTerminal, type Terminal } from "@earendil-works/pi-tui";
import { createAdamCommandRegistry } from "./command-registry.js";
import { type FixtureScenario, isFixtureScenario } from "./fixture-scenario.js";
import { requireConfirmedLifecycleClose } from "./lifecycle-close.js";
import { type ClipboardAdapter, type DeadlineScheduler, runTui } from "./tui-app.js";
import { tuiProcessFailureMessage } from "./tui-process-failure.js";

const targetIdentity: ModelTargetIdentity = {
  targetId: "fake.local",
  vendor: "adam",
  modelId: "fake-local",
  route: "direct",
  profileVersion: 1,
  certification: "certified",
};
const alternateTargetIdentity: ModelTargetIdentity = {
  targetId: "fake.other",
  vendor: "adam",
  modelId: "fake-other",
  route: "direct",
  profileVersion: 1,
  certification: "experimental",
};
const hostileTargetIdentity: ModelTargetIdentity = {
  targetId:
    "fixture-catalog-owned-target-with-a-deliberately-long-exact-identity-for-responsive-detail-wrapping.direct",
  vendor: "fixture-provider",
  modelId: "fixture-hostile-catalog",
  route: "direct",
  profileVersion: 1,
  certification: "experimental",
};
const launchTargetIdentities: readonly ModelTargetIdentity[] = [
  {
    targetId: "deepseek-v4-flash.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-flash",
    route: "direct",
    profileVersion: 3,
    certification: "certified",
  },
  {
    targetId: "deepseek-v4-pro.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-pro",
    route: "direct",
    profileVersion: 3,
    certification: "certified",
  },
  {
    targetId: "deepseek-v4-flash-vision-exp.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-flash-vision-exp",
    route: "direct",
    profileVersion: 1,
    certification: "certified",
  },
];
const fixtureThinkingCapabilities = new Map(
  [...launchTargetIdentities, targetIdentity].map((identity) => {
    const capability = {
      schemaVersion: 1 as const,
      capabilityId: `deepseek-chat-thinking:${identity.targetId}:target-profile-${identity.profileVersion}`,
      capabilityVersion: 1 as const,
      targetIdentity: identity,
      providerProfile: {
        id: "@ai-sdk/deepseek/chat" as const,
        version:
          identity.profileVersion >= 3 || identity.modelId === "deepseek-v4-flash-vision-exp"
            ? ("3.0.30" as const)
            : ("3.0.28" as const),
        requestPath: "provider_options.deepseek" as const,
      },
      supportsOff: true as const,
      defaultLevelId: "high",
      providerDefault: { effectiveLevelId: "high", mutable: true as const },
      levels: [
        {
          id: "off",
          label: "Off",
          effectiveLevelId: "off",
          mapping: {
            requestPath: "provider_options.deepseek" as const,
            thinkingType: "disabled" as const,
          },
        },
        ...(["low", "high", "max"] as const).map((level) => ({
          id: level,
          label: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
          effectiveLevelId: level,
          mapping: {
            requestPath: "provider_options.deepseek" as const,
            thinkingType: "enabled" as const,
            reasoningEffort: level,
          },
        })),
      ],
      reasoningArtifact: "provider_reasoning" as const,
    };
    return [
      identity.targetId,
      {
        ...capability,
        capabilityDigest: `sha256:${createHash("sha256")
          .update(JSON.stringify(capability), "utf8")
          .digest("hex")}` as const,
      },
    ] as const;
  }),
);
const contextProfile: ContextProfile = {
  version: 1,
  contextWindowTokens: 32_768,
  maximumOutputTokens: 4_096,
  compactAtTokens: 24_576,
  postCompactTargetTokens: 8_192,
  retainedTargetTokens: 4_096,
  estimatorVersion: 1,
};

export type TuiFixtureOptions = {
  readonly clipboard?: ClipboardAdapter;
  readonly controlRoot?: string;
  readonly deadlineScheduler?: DeadlineScheduler;
  readonly launch?: {
    readonly configRoot?: string;
    readonly seedTargetIds?: readonly string[];
    readonly startupTargetId?: string;
    readonly workspaceTrust?: "owner-local" | "unavailable";
    readonly workspaceTrustMutation?: "reject";
  };
  readonly mouse?: boolean;
  readonly presentationCloseMarker?: string;
  readonly scenario?: FixtureScenario;
  readonly stateRoot: string;
  readonly terminal?: Terminal;
  readonly terminalProcessMarker?: string;
  readonly workspaceRoot: string;
};

class TerminalRestorationFailure extends ProcessTerminal {
  readonly #failureMarker: string | undefined;

  constructor(failureMarker: string | undefined) {
    super();
    this.#failureMarker = failureMarker;
  }

  override stop(): void {
    super.stop();
    if (this.#failureMarker !== undefined) {
      writeFileSync(this.#failureMarker, "failed\n", "utf8");
    }
    throw new Error("Injected terminal stop failure after restoration.");
  }
}

export async function runTuiFixture(options: TuiFixtureOptions): Promise<void> {
  if (options.terminalProcessMarker !== undefined) {
    await writeFile(options.terminalProcessMarker, `${process.pid}\n`, "utf8");
  }
  const modelTargets = createFixtureModelTargets(options);
  const preferences =
    options.launch === undefined
      ? undefined
      : createPresentationPreferences({
          environment: {
            ...process.env,
            ...(options.launch.configRoot === undefined
              ? {}
              : { XDG_CONFIG_HOME: options.launch.configRoot }),
          },
        });
  const lifecycle = createSessionLifecycle({
    ...(options.scenario === "plan-review-recovery"
      ? {
          [planApprovalIntentBarrier]: {
            afterDurableRecord() {
              throw new Error("Injected stop after durable Plan approval intent.");
            },
          },
        }
      : {}),
    ...(options.scenario === "mcp-close-unconfirmed"
      ? {
          [mcpCloseConfirmation]: {
            async confirm() {
              throw new Error("Fixture close confirmation failed.");
            },
          },
        }
      : {}),
    ...(modelTargets === undefined ? {} : { modelTargets }),
    ...(preferences === undefined ? {} : { preferences }),
    permissions: createPermissionPolicy({
      allowedEffects:
        options.scenario === "todo"
          ? ["read", "write"]
          : options.scenario === "tool-artifact" || options.scenario === "shell"
            ? ["read", "execute"]
            : ["read"],
      askedEffects: ["write"],
    }),
    workspaceTrust:
      options.launch?.workspaceTrust === "owner-local"
        ? createWorkspaceTrust({
            environment: {
              ...process.env,
              ...(options.launch.configRoot === undefined
                ? {}
                : { XDG_CONFIG_HOME: options.launch.configRoot }),
            },
            workspaceRoot: options.workspaceRoot,
          })
        : options.launch?.workspaceTrust === "unavailable"
          ? unavailableWorkspaceTrust()
          : createTrustedWorkspaceTrustForTesting(options.workspaceRoot),
    stateRoot: options.stateRoot,
    workspaceRoot: options.workspaceRoot,
  });
  const reviewFixture =
    options.scenario === "review-operation" ||
    options.scenario === "review-operation-long-provenance" ||
    options.scenario === "review-completed" ||
    options.scenario === "review-recovery"
      ? await createReviewOperationFixture(
          options.stateRoot,
          options.workspaceRoot,
          options.scenario,
        )
      : undefined;
  let lifecycleCloseAttempted = false;

  try {
    const previewBarrier = previewReadBarrier(options);
    const composerBarrier =
      options.scenario === "input-resource-copying" && options.controlRoot !== undefined
        ? {
            async afterOpen() {
              await writeFile(
                join(options.controlRoot as string, "input-resource-copying"),
                "copying\n",
              );
              await waitForFile(options.controlRoot as string, "release-input-resource-copy");
            },
          }
        : undefined;
    for (const seedTargetId of options.launch?.seedTargetIds ?? []) {
      const seeded = await lifecycle.create({
        targetIdentity: requireLaunchTargetIdentity(seedTargetId),
      });
      await lifecycle.continue({
        sessionId: seeded.sessionId,
        input: { text: `Seeded project session for ${seedTargetId}` },
      });
    }
    if (options.scenario === "session-selection-history") {
      const selectable = await lifecycle.create({ targetIdentity });
      await lifecycle.continue({
        sessionId: selectable.sessionId,
        input: { text: "Selected session prompt" },
      });
      await lifecycle.setSessionManualName({
        sessionId: selectable.sessionId,
        name: "Selected project session",
      });
    }
    if (options.scenario === "reasoning-artifact-session-race") {
      const switchTarget = await lifecycle.create({ targetIdentity });
      await lifecycle.continue({
        sessionId: switchTarget.sessionId,
        input: { text: "Switch target reasoning prompt" },
      });
      await lifecycle.setSessionManualName({
        sessionId: switchTarget.sessionId,
        name: "Switch target session",
      });
    }
    if (options.scenario === "tool-multiple") {
      const switchTarget = await lifecycle.create({ targetIdentity });
      await lifecycle.continue({
        sessionId: switchTarget.sessionId,
        input: { text: "Seeded project session for tool disclosure switch" },
      });
      await lifecycle.setSessionManualName({
        sessionId: switchTarget.sessionId,
        name: "Tool disclosure switch session",
      });
    }
    const resumedSessionId =
      options.scenario === "resume" ||
      options.scenario === "history" ||
      options.scenario === "artifact-history" ||
      options.scenario === "copy-older-assistant" ||
      options.scenario === "reasoning-multiple" ||
      options.scenario === "reasoning-large-multiple" ||
      options.scenario === "reasoning-artifact-session-race" ||
      options.scenario === "target-navigation" ||
      options.scenario === "target-navigation-unavailable" ||
      options.scenario === "tool-multiple" ||
      options.scenario === "unsafe-history"
        ? await lifecycle.create({ targetIdentity }).then(async (created) => {
            if (options.scenario === "history") {
              for (let index = 1; index <= 3; index += 1) {
                await lifecycle.continue({
                  sessionId: created.sessionId,
                  input: { text: `History prompt ${index}` },
                });
              }
            } else if (options.scenario === "artifact-history") {
              for (const text of [
                "Artifact history prompt",
                "Later history prompt one",
                "Later history prompt two",
              ]) {
                await lifecycle.continue({
                  sessionId: created.sessionId,
                  input: { text },
                });
              }
            } else if (options.scenario === "copy-older-assistant") {
              for (const text of [
                "Older copy prompt",
                "Later copy prompt one",
                "Later copy prompt two",
              ]) {
                await lifecycle.continue({ sessionId: created.sessionId, input: { text } });
              }
            } else if (
              options.scenario === "reasoning-multiple" ||
              options.scenario === "reasoning-large-multiple"
            ) {
              for (let block = 1; block <= 3; block += 1) {
                await lifecycle.continue({
                  sessionId: created.sessionId,
                  input: { text: `Inspect seeded reasoning block ${block}` },
                });
              }
            } else if (options.scenario === "tool-multiple") {
              for (let card = 1; card <= 3; card += 1) {
                await lifecycle.continue({
                  sessionId: created.sessionId,
                  input: { text: `Inspect seeded tool card ${card}` },
                });
              }
              await lifecycle.setSessionManualName({
                sessionId: created.sessionId,
                name: "Tool disclosure source session",
              });
            } else if (options.scenario === "reasoning-artifact-session-race") {
              await lifecycle.continue({
                sessionId: created.sessionId,
                input: { text: "Reasoning source prompt" },
              });
              await lifecycle.setSessionManualName({
                sessionId: created.sessionId,
                name: "Reasoning source session",
              });
            } else if (options.scenario === "resume") {
              await lifecycle.continue({
                sessionId: created.sessionId,
                input: { text: "Resume transcript" },
              });
            } else if (
              options.scenario === "target-navigation" ||
              options.scenario === "target-navigation-unavailable"
            ) {
              await lifecycle.continue({
                sessionId: created.sessionId,
                input: { text: "Keep historical target identity" },
              });
            } else {
              await lifecycle.continue({
                sessionId: created.sessionId,
                input: { text: "\u001b]52;c;c2NvcGU=\u0007Visible history\u202E" },
              });
            }
            return created.sessionId;
          })
        : options.launch === undefined && options.scenario !== "session-selection-history"
          ? await lifecycle.create({ targetIdentity }).then((created) => created.sessionId)
          : undefined;
    const presentation = await createPresentationSession(
      options.launch !== undefined
        ? {
            lifecycle,
            ...(reviewFixture === undefined
              ? {}
              : { operations: reviewFixture.host.operations, projectChanges: reviewFixture.host }),
            ...(modelTargets === undefined ? {} : { modelTargets }),
            openProject: true,
            ...(preferences === undefined ? {} : { preferences }),
            projectLabel: "workspace",
            stateRoot: options.stateRoot,
            workspaceRoot: options.workspaceRoot,
            ...(composerBarrier === undefined
              ? {}
              : { [turnComposerStageBarrier]: composerBarrier }),
          }
        : options.scenario === "session-selection-history"
          ? {
              lifecycle,
              ...(reviewFixture === undefined
                ? {}
                : {
                    operations: reviewFixture.host.operations,
                    projectChanges: reviewFixture.host,
                  }),
              ...(modelTargets === undefined ? {} : { modelTargets }),
              openProject: true,
              projectLabel: "workspace",
              stateRoot: options.stateRoot,
              workspaceRoot: options.workspaceRoot,
              ...(composerBarrier === undefined
                ? {}
                : { [turnComposerStageBarrier]: composerBarrier }),
            }
          : resumedSessionId === undefined
            ? {
                lifecycle,
                ...(reviewFixture === undefined
                  ? {}
                  : {
                      operations: reviewFixture.host.operations,
                      projectChanges: reviewFixture.host,
                    }),
                ...(modelTargets === undefined ? {} : { modelTargets }),
                projectLabel: "workspace",
                stateRoot: options.stateRoot,
                targetIdentity,
                workspaceRoot: options.workspaceRoot,
                ...(previewBarrier === undefined
                  ? {}
                  : { [presentationArtifactReadBarrier]: previewBarrier }),
                ...(composerBarrier === undefined
                  ? {}
                  : { [turnComposerStageBarrier]: composerBarrier }),
              }
            : {
                lifecycle,
                ...(reviewFixture === undefined
                  ? {}
                  : {
                      operations: reviewFixture.host.operations,
                      projectChanges: reviewFixture.host,
                    }),
                ...(modelTargets === undefined ? {} : { modelTargets }),
                projectLabel: "workspace",
                sessionId: resumedSessionId,
                stateRoot: options.stateRoot,
                workspaceRoot: options.workspaceRoot,
                ...(options.scenario === "history" ||
                options.scenario === "artifact-history" ||
                options.scenario === "copy-older-assistant"
                  ? { [presentationHistoryPageSize]: 2 }
                  : {}),
                ...(previewBarrier === undefined
                  ? {}
                  : { [presentationArtifactReadBarrier]: previewBarrier }),
                ...(composerBarrier === undefined
                  ? {}
                  : { [turnComposerStageBarrier]: composerBarrier }),
              },
    );
    if (options.scenario === "target-connection-multiple" && options.controlRoot !== undefined) {
      const targetIds = ["deepseek-v4-flash.direct", "deepseek-v4-pro.direct"] as const;
      const started = targetIds.map((targetId) =>
        waitForFile(options.controlRoot as string, `target-connection-pending-${targetId}`),
      );
      for (const targetId of targetIds) {
        void presentation.dispatch({ type: "test_target_connection", targetId });
      }
      if ((await Promise.all(started)).some((ready) => !ready)) {
        throw new Error("The multiple target connection fixture did not become pending.");
      }
    }
    const clipboard = options.clipboard ?? clipboardAdapter(options);
    const deadlineScheduler = options.deadlineScheduler ?? controlledDeadlineScheduler(options);
    const tuiPresentation = observeTuiDispatch(presentation, options);
    const closeRuntime = async () => {
      let presentationFailure: unknown;
      try {
        await tuiPresentation.close();
      } catch (error) {
        presentationFailure = error;
      }
      if (options.scenario === "mcp-close-unconfirmed") {
        lifecycleCloseAttempted = true;
        requireConfirmedLifecycleClose(await lifecycle.close());
      }
      if (presentationFailure !== undefined) {
        throw presentationFailure;
      }
    };
    const terminal =
      options.terminal ??
      (options.scenario === "mcp-close-unconfirmed"
        ? new TerminalRestorationFailure(
            options.controlRoot === undefined
              ? undefined
              : join(options.controlRoot, "terminal-restoration-failed"),
          )
        : undefined);
    await runTui({
      ...(clipboard === undefined ? {} : { clipboard }),
      closeRuntime,
      ...(options.scenario === "review-unavailable" || reviewFixture !== undefined
        ? {
            commandRegistry: createAdamCommandRegistry(
              reviewFixture === undefined
                ? [
                    {
                      id: "fixture.local-worktree-review",
                      name: "review",
                      title: "Review project changes",
                      version: 1,
                    },
                  ]
                : reviewFixture.host
                    .listContributions()
                    .flatMap((contribution) =>
                      contribution.command === undefined ? [] : [contribution.command],
                    ),
            ),
          }
        : {}),
      ...(deadlineScheduler === undefined ? {} : { deadlineScheduler }),
      ...(options.mouse === undefined ? {} : { mouse: options.mouse }),
      presentation: tuiPresentation,
      ...(options.launch === undefined
        ? {
            targetStatus: {
              targetId: targetIdentity.targetId,
              certification: "Certified" as const,
            },
          }
        : options.launch.startupTargetId === undefined
          ? {}
          : { startupTargetId: options.launch.startupTargetId }),
      ...(terminal === undefined ? {} : { terminal }),
    });
  } finally {
    reviewFixture?.releaseExecution();
    if (!lifecycleCloseAttempted) {
      requireConfirmedLifecycleClose(await lifecycle.close());
    }
    if (options.controlRoot !== undefined) {
      await writeFile(join(options.controlRoot, "tui-fixture-closed"), "closed\n", "utf8");
    }
  }
}

function unavailableWorkspaceTrust(): WorkspaceTrustController {
  const snapshot = {
    projectId: null,
    projectLabel: "workspace",
    status: "unavailable" as const,
    diagnostic: {
      code: "workspace_trust_unavailable" as const,
      message: "The canonical workspace identity is unavailable.",
    },
  };
  return {
    async acquireMcpLease() {
      return { async release() {} };
    },
    async load() {
      return snapshot;
    },
    async setTrusted() {
      throw new TypeError("The canonical workspace identity is unavailable.");
    },
  };
}

async function createReviewOperationFixture(
  stateRoot: string,
  workspaceRoot: string,
  mode:
    | "review-completed"
    | "review-operation"
    | "review-operation-long-provenance"
    | "review-recovery",
) {
  const packageRoot = join(stateRoot, "review-extension");
  const extensionId =
    mode === "review-operation-long-provenance"
      ? `fixture.review-extension.${"extension-segment.".repeat(4)}final`
      : "fixture.review-extension";
  const contributionId =
    mode === "review-operation-long-provenance"
      ? `fixture.local-worktree-review.${"contribution-segment.".repeat(4)}final@1`
      : "fixture.local-worktree-review@1";
  const controlKey = `__adamTuiReview${process.pid}${Date.now()}${Math.random()}`;
  const executionRelease = Promise.withResolvers<void>();
  (globalThis as Record<string, unknown>)[controlKey] = {
    releaseExecution: executionRelease.promise,
  };
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/review-extension",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: extensionId,
        apiVersion: "^0.3.0",
        runtime: { entry: "./runtime.js" },
        capabilities: {
          required: [{ id: "adam.artifact.publish@1", version: "^1.0.0" }],
          optional: [],
        },
        contributions: [
          {
            command: {
              id: "fixture.review",
              name: "review",
              title: "Review project changes",
              version: 1,
            },
            id: contributionId,
            input: { id: "adam.project-change-snapshot", version: 1 },
            inputSource: { id: "project_changes", version: 1 },
            kind: "operation",
            output: { id: "fixture.review-result", version: 1 },
            progress: { id: "fixture.review-progress", version: 1 },
            report: { id: "fixture.review-result", version: 1 },
            ...(mode === "review-recovery" ? { recovery: { version: 1 } } : {}),
          },
        ],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "runtime.js"),
    `const codec = (id) => ({
  id,
  version: 1,
  decode(value) { return { ok: true, value }; },
  encode(value) { return { ok: true, value }; },
});
export function activate(context) {
  context.registerOperation({
    id: ${JSON.stringify(contributionId)},
    input: codec("adam.project-change-snapshot"),
    output: codec("fixture.review-result"),
    progress: codec("fixture.review-progress"),
    async execute(input, operation) {
      await operation.progress("analyzing project changes");
      ${
        mode === "review-operation" || mode === "review-operation-long-provenance"
          ? `await Promise.race([
        globalThis[${JSON.stringify(controlKey)}].releaseExecution,
        new Promise((_, reject) => {
          operation.signal.addEventListener("abort", () => reject(operation.signal.reason), { once: true });
        }),
      ]);`
          : ""
      }
      const output = { digest: input.digest, reviewed: true, summary: "Review complete" };
      ${
        mode === "review-recovery"
          ? ""
          : `await operation.capabilities["adam.artifact.publish@1"].publish({
        bytes: new TextEncoder().encode(JSON.stringify(output)),
        contract: { id: "fixture.review-result", version: 1 },
        mediaType: "application/json",
      });`
      }
      return output;
    },
    ${
      mode === "review-recovery"
        ? `reconcile(input) {
      return { status: "completed", output: { digest: input.digest, reviewed: true, summary: "Recovered review" } };
    },`
        : ""
    }
  });
}
`,
    "utf8",
  );
  const artifactStore = await createFileArtifactStore({
    root: join(stateRoot, "artifacts"),
  });
  const durableOperationStore = createInMemoryOperationStore();
  let rejectOriginalTerminal = mode === "review-recovery";
  const operationStore =
    mode === "review-recovery"
      ? {
          async append(record: Parameters<typeof durableOperationStore.append>[0]) {
            if (rejectOriginalTerminal && record.event.type === "operation_completed") {
              rejectOriginalTerminal = false;
              throw new Error("injected terminal persistence failure");
            }
            await durableOperationStore.append(record);
          },
          findByIdempotency: durableOperationStore.findByIdempotency,
          listLinkedStarts: durableOperationStore.listLinkedStarts,
          read: durableOperationStore.read,
        }
      : durableOperationStore;
  const host = createExtensionHost({
    artifactStore,
    capabilities: [{ id: "adam.artifact.publish@1", version: "1.0.0" }],
    extensions: [
      {
        enabled: true,
        extensionId,
        grants: [{ id: "adam.artifact.publish@1", version: "^1.0.0" }],
        packageName: "@fixture/review-extension",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    operationOriginAuthority: { validateBoundary: async () => true },
    operationStore,
    projectChangeMaterializer: {
      async materialize() {
        return {
          base: { commit: "a".repeat(40), kind: "head" as const, tree: "b".repeat(40) },
          candidateTree: "c".repeat(40),
          capturePolicy: {
            id: "adam.git-project-changes" as const,
            objectFormat: "sha1" as const,
            version: 1 as const,
          },
          digest: `sha256:${"d".repeat(64)}` as const,
          kind: "adam.project-change-snapshot" as const,
          schemaVersion: 1 as const,
          sources: [
            {
              content: "export const reviewed = true;\n",
              contentDigest: `sha256:${"e".repeat(64)}` as const,
              mode: "100644" as const,
              path: "src/reviewed.ts",
              side: "head" as const,
            },
          ],
          unavailable: [],
          unifiedDiff: "diff --git a/src/reviewed.ts b/src/reviewed.ts\n",
        };
      },
    },
    projectRoot: workspaceRoot,
    stateRoot: join(stateRoot, "review-extension-state"),
  });
  await host.loadConfiguredExtensions();
  return {
    host,
    releaseExecution() {
      executionRelease.resolve();
      delete (globalThis as Record<string, unknown>)[controlKey];
    },
  };
}

function observeTuiDispatch(
  presentation: PresentationSession,
  options: {
    readonly controlRoot?: string;
    readonly launch?: TuiFixtureOptions["launch"];
    readonly presentationCloseMarker?: string;
    readonly scenario?: FixtureScenario;
  },
): PresentationSession {
  const controlRoot = options.controlRoot;
  const rejectWorkspaceTrustMutation = options.launch?.workspaceTrustMutation === "reject";
  const observeWorkspaceTrustAdmission = options.launch?.workspaceTrust === "owner-local";
  const observeNamingDispatch = controlRoot !== undefined;
  const observeDispatch =
    controlRoot !== undefined &&
    (options.scenario === "mutation-delayed-preview" ||
      options.scenario === "tool-artifact" ||
      options.scenario === "artifact-backed-assistant" ||
      options.scenario === "artifact-page-race" ||
      options.scenario === "reasoning-artifact" ||
      options.scenario === "reasoning-artifact-race" ||
      options.scenario === "reasoning-artifact-reorder" ||
      options.scenario === "reasoning-artifact-session-race" ||
      options.scenario === "reasoning-large-multiple" ||
      options.scenario === "reasoning-large-live" ||
      options.scenario === "review-completed" ||
      options.scenario === "review-recovery");
  if (
    !observeNamingDispatch &&
    !observeDispatch &&
    !rejectWorkspaceTrustMutation &&
    options.presentationCloseMarker === undefined
  ) {
    return presentation;
  }
  let artifactReadCount = 0;
  let reasoningSettlementObserved = false;
  let targetNavigationSettlementObserved = false;
  return {
    async close() {
      await presentation.close();
      if (options.presentationCloseMarker !== undefined) {
        await writeFile(options.presentationCloseMarker, "closed\n", "utf8");
      }
    },
    dispatch: async (command) => {
      if (command.type === "set_workspace_trust" && rejectWorkspaceTrustMutation) {
        return {
          status: "rejected",
          code: "persistence_failed",
          message: "Injected trust mutation rejection.",
        };
      }
      const receipt = presentation.dispatch(command);
      if (
        command.type === "set_workspace_trust" &&
        controlRoot !== undefined &&
        observeWorkspaceTrustAdmission
      ) {
        const settled = await receipt;
        await writeFile(
          join(controlRoot, "workspace-trust-dispatch-settled"),
          `${settled.status}\n`,
          "utf8",
        );
        return settled;
      }
      if (
        command.type === "create_session" &&
        controlRoot !== undefined &&
        observeWorkspaceTrustAdmission
      ) {
        const settled = await receipt;
        await writeFile(
          join(controlRoot, "create-session-dispatch-settled"),
          `${settled.status}\n`,
          "utf8",
        );
        return settled;
      }
      if (command.type === "set_session_manual_name" && controlRoot !== undefined) {
        const settled = await receipt;
        await writeFile(
          join(controlRoot, "session-name-dispatch-settled"),
          `${settled.status}\n`,
          "utf8",
        );
        return settled;
      }
      if (command.type === "clear_session_manual_name" && controlRoot !== undefined) {
        const settled = await receipt;
        await writeFile(
          join(controlRoot, "clear-session-name-dispatch-settled"),
          `${settled.status}\n`,
          "utf8",
        );
        return settled;
      }
      if (!observeDispatch) {
        return receipt;
      }
      if (command.type === "decide_permission") {
        await writeFile(
          join(controlRoot as string, "permission-decision-submitted"),
          `${command.decision}\n`,
          "utf8",
        );
      }
      if (command.type === "read_artifact") {
        const artifactReadOrdinal = ++artifactReadCount;
        await writeFile(
          join(controlRoot as string, `artifact-read-${artifactReadOrdinal}`),
          `${command.range?.offset ?? 0}\n`,
          "utf8",
        );
        await writeFile(
          join(controlRoot as string, `artifact-read-${artifactReadOrdinal}-range`),
          command.range === null
            ? "complete\n"
            : `${command.range.offset}:${command.range.maximumBytes}\n`,
          "utf8",
        );
        await writeFile(
          join(controlRoot as string, `artifact-read-${artifactReadOrdinal}-id`),
          `${command.artifact.id}\n`,
          "utf8",
        );
        const settled = await receipt;
        await writeFile(
          join(controlRoot as string, `artifact-read-${artifactReadOrdinal}-settled`),
          "settled\n",
          "utf8",
        );
        return settled;
      }
      if (command.type === "recover_operation") {
        await writeFile(
          join(controlRoot as string, "operation-recover-submitted"),
          "recover\n",
          "utf8",
        );
      }
      if (command.type === "submit_prompt") {
        await writeFile(
          join(controlRoot as string, "prompt-submitted"),
          `${command.text}\n`,
          "utf8",
        );
      }
      return receipt;
    },
    getState: () => presentation.getState(),
    subscribe: (onChange) =>
      presentation.subscribe(() => {
        onChange();
        const state = presentation.getState();
        if (
          !reasoningSettlementObserved &&
          (options.scenario === "reasoning-streaming" ||
            options.scenario === "reasoning-artifact" ||
            options.scenario === "reasoning-artifact-race" ||
            options.scenario === "reasoning-artifact-reorder" ||
            options.scenario === "reasoning-artifact-session-race" ||
            options.scenario === "reasoning-large-multiple" ||
            options.scenario === "reasoning-large-live") &&
          controlRoot !== undefined &&
          state.authoritative.active?.session.status === "settled" &&
          state.transient === null
        ) {
          reasoningSettlementObserved = true;
          void writeFile(join(controlRoot, "reasoning-session-settled"), "settled\n", "utf8");
        }
        if (
          !targetNavigationSettlementObserved &&
          options.scenario === "target-navigation" &&
          controlRoot !== undefined &&
          state.authoritative.active?.session.targetId === alternateTargetIdentity.targetId &&
          state.authoritative.active.session.status === "settled" &&
          state.transient === null
        ) {
          targetNavigationSettlementObserved = true;
          void writeFile(
            join(controlRoot, "target-navigation-session-settled"),
            "settled\n",
            "utf8",
          );
        }
      }),
  };
}

function parseArguments(arguments_: readonly string[]): {
  readonly controlRoot?: string;
  readonly scenario?: FixtureScenario;
  readonly stateRoot: string;
  readonly terminalProcessMarker?: string;
  readonly workspaceRoot: string;
} {
  const stateRoot = optionValue(arguments_, "--state-root");
  const workspaceRoot = optionValue(arguments_, "--workspace-root");
  if (stateRoot === undefined || workspaceRoot === undefined) {
    throw new TypeError("The TUI fixture requires --state-root and --workspace-root.");
  }
  const scenario = optionValue(arguments_, "--scenario");
  if (scenario !== undefined && !isFixtureScenario(scenario)) {
    throw new TypeError("The TUI fixture scenario is invalid.");
  }
  const controlRoot = optionValue(arguments_, "--control-root");
  const terminalProcessMarker = optionValue(arguments_, "--terminal-process-marker");
  return {
    ...(controlRoot === undefined ? {} : { controlRoot }),
    ...(scenario === undefined ? {} : { scenario }),
    stateRoot,
    ...(terminalProcessMarker === undefined ? {} : { terminalProcessMarker }),
    workspaceRoot,
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const options = parseArguments(process.argv.slice(2));
  try {
    await runTuiFixture(options);
  } catch (error) {
    if (options.scenario !== "mcp-close-unconfirmed") {
      throw error;
    }
    process.stderr.write(`${tuiProcessFailureMessage(error)}\n`);
    process.exitCode = 1;
  }
}

function optionValue(arguments_: readonly string[], option: string): string | undefined {
  const index = arguments_.indexOf(option);
  return index < 0 ? undefined : arguments_[index + 1];
}

function createFixtureModelTargets(options: {
  readonly controlRoot?: string;
  readonly launch?: TuiFixtureOptions["launch"];
  readonly scenario?: FixtureScenario;
}): ModelTargets | undefined {
  if (
    options.launch === undefined &&
    (options.scenario === undefined ||
      options.scenario === "clipboard-success" ||
      options.scenario === "clipboard-timeout" ||
      options.scenario === "deadline")
  ) {
    return undefined;
  }
  if (
    (options.scenario === "streaming" ||
      options.scenario === "reasoning-streaming" ||
      options.scenario === "reasoning-live-viewport") &&
    options.controlRoot === undefined
  ) {
    throw new TypeError("The streaming fixtures require --control-root.");
  }
  let artifactResponseOrdinal = 0;
  let planSubmissionOrdinal = 0;
  let reasoningViewportOrdinal = 0;
  let toolPreviewOrdinal = 0;
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        yield {
          type: "text_delta",
          text:
            request.maximumOutputTokens === 64
              ? "Streaming session"
              : JSON.stringify({
                  schemaVersion: 1,
                  objective: "Preserve the active TUI fixture task.",
                  constraints: [],
                  progress: ["The shell tool completed and preserved its bounded output."],
                  unresolvedQuestions: [],
                  failures: [],
                  remainingVerification: [],
                  nextSafeAction: "Continue the active model turn.",
                }),
        };
        yield { type: "finish", reason: "stop" };
        return;
      }
      const latestUser = [...request.messages].reverse().find((message) => message.role === "user");
      if (
        latestUser?.role === "user" &&
        typeof latestUser.content === "string" &&
        latestUser.content.startsWith("Seeded project session for ")
      ) {
        yield { type: "text_delta", text: "Seeded project session ready." };
        yield { type: "finish", reason: "stop" };
        return;
      }
      if (options.scenario === "plan-review" || options.scenario === "plan-review-recovery") {
        if (request.approvedPlan !== undefined) {
          yield { type: "text_delta", text: "Approved Plan implementation complete." };
        } else {
          const latest = request.messages.at(-1);
          if (
            latest?.role !== "user" ||
            !request.tools.some((tool) => tool.name === "submit_plan")
          ) {
            throw new TypeError("The Plan review fixture requires one exploring user turn.");
          }
          planSubmissionOrdinal += 1;
          const callId = `submit-plan-review-${planSubmissionOrdinal}`;
          yield { type: "tool_call_start", id: callId, name: "submit_plan" };
          yield {
            type: "tool_call_delta",
            id: callId,
            json: JSON.stringify({
              title: `Fixture plan ${planSubmissionOrdinal}`,
              markdown: `# Fixture plan ${planSubmissionOrdinal}\n\n1. Implement the exact reviewed change.\n2. Verify it.\n`,
            }),
          };
          yield { type: "tool_call_end", id: callId };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
      } else if (options.scenario === "read") {
        const latest = request.messages.at(-1);
        if (latest?.role === "user") {
          yield { type: "tool_call_start", id: "read-readme", name: "read_file" };
          yield { type: "tool_call_delta", id: "read-readme", json: '{"path":"README.md"}' };
          yield { type: "tool_call_end", id: "read-readme" };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: "Read complete." };
      } else if (options.scenario === "search") {
        const latest = request.messages.at(-1);
        if (latest?.role === "user") {
          yield { type: "tool_call_start", id: "search-repository", name: "search_repository" };
          yield {
            type: "tool_call_delta",
            id: "search-repository",
            json: '{"kind":"content","query":"orchard"}',
          };
          yield { type: "tool_call_end", id: "search-repository" };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: "Search complete." };
      } else if (options.scenario === "todo") {
        const latest = request.messages.at(-1);
        if (latest?.role === "user") {
          yield { type: "tool_call_start", id: "create-todo-fixture", name: "create_todo" };
          yield {
            type: "tool_call_delta",
            id: "create-todo-fixture",
            json: JSON.stringify({
              title: "Exact Todo fixture",
              details: "Caller-visible Todo detail.",
            }),
          };
          yield { type: "tool_call_end", id: "create-todo-fixture" };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: "Todo fixture created." };
      } else if (options.scenario === "tool-multiple") {
        const latest = request.messages.at(-1);
        if (latest?.role === "user") {
          toolPreviewOrdinal += 1;
          yield {
            type: "tool_call_start",
            id: `read-multiple-${toolPreviewOrdinal}`,
            name: "read_file",
          };
          yield {
            type: "tool_call_delta",
            id: `read-multiple-${toolPreviewOrdinal}`,
            json: JSON.stringify({ path: `tool-${toolPreviewOrdinal}.txt` }),
          };
          yield { type: "tool_call_end", id: `read-multiple-${toolPreviewOrdinal}` };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: `Multiple tool answer ${toolPreviewOrdinal}.` };
      } else if (options.scenario === "write") {
        const latest = request.messages.at(-1);
        if (latest?.role === "user") {
          const content = Array.from(
            { length: 12 },
            (_, index) => `export const value${String(index + 1).padStart(2, "0")} = ${index + 1};`,
          ).join("\n");
          yield { type: "tool_call_start", id: "write-file", name: "write_file" };
          yield {
            type: "tool_call_delta",
            id: "write-file",
            json: JSON.stringify({ path: "created.ts", content: `${content}\n` }),
          };
          yield { type: "tool_call_end", id: "write-file" };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: "Write complete." };
      } else if (
        options.scenario === "mutation" ||
        options.scenario === "mutation-long-preview" ||
        options.scenario === "mutation-after-release" ||
        options.scenario === "mutation-after-release-with-continuation-barrier" ||
        options.scenario === "mutation-delayed-preview"
      ) {
        const latest = request.messages.at(-1);
        if (latest?.role === "user") {
          if (
            options.scenario === "mutation-after-release" ||
            options.scenario === "mutation-after-release-with-continuation-barrier"
          ) {
            await writeFile(
              join(options.controlRoot as string, "model-started"),
              "started\n",
              "utf8",
            );
            if (
              !(await waitForFile(options.controlRoot as string, "release-model", request.signal))
            ) {
              throw request.signal.reason;
            }
          }
          yield { type: "tool_call_start", id: "edit-file", name: "edit_file" };
          yield {
            type: "tool_call_delta",
            id: "edit-file",
            json: JSON.stringify({
              operations: [
                {
                  kind: "update",
                  path: "edit.txt",
                  edits: [
                    options.scenario === "mutation-long-preview"
                      ? {
                          oldText: Array.from(
                            { length: 20 },
                            (_, index) => `before-${String(index + 1).padStart(2, "0")}`,
                          ).join("\n"),
                          newText: Array.from(
                            { length: 20 },
                            (_, index) => `after-${String(index + 1).padStart(2, "0")}`,
                          ).join("\n"),
                        }
                      : { oldText: "before", newText: "after" },
                  ],
                },
              ],
            }),
          };
          yield { type: "tool_call_end", id: "edit-file" };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        if (options.scenario === "mutation-after-release-with-continuation-barrier") {
          await writeFile(
            join(options.controlRoot as string, "model-continuation-ready"),
            "ready\n",
            "utf8",
          );
          if (
            !(await waitForFile(
              options.controlRoot as string,
              "release-model-continuation",
              request.signal,
            ))
          ) {
            throw request.signal.reason;
          }
        }
        yield { type: "text_delta", text: "Edit complete." };
      } else if (options.scenario === "cancellation") {
        if (options.controlRoot !== undefined) {
          await writeFile(join(options.controlRoot, "model-started"), "started\n", "utf8");
        }
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) {
            resolve();
            return;
          }
          request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw request.signal.reason;
      } else if (
        options.scenario === "history" ||
        options.scenario === "session-selection-history" ||
        options.scenario === "unsafe-history"
      ) {
        yield { type: "text_delta", text: "History answer." };
      } else if (options.scenario === "artifact-history") {
        const latestUser = [...request.messages]
          .reverse()
          .find((message) => message.role === "user");
        yield {
          type: "text_delta",
          text:
            latestUser?.role === "user" && latestUser.content === "Artifact history prompt"
              ? `Older artifact page\n${"h".repeat(270_000)}`
              : "Later history answer.",
        };
      } else if (options.scenario === "resume") {
        yield { type: "text_delta", text: "Previous answer." };
      } else if (
        options.scenario === "target-navigation" ||
        options.scenario === "target-navigation-unavailable"
      ) {
        yield { type: "text_delta", text: "Target navigation answer." };
      } else if (options.scenario === "shell") {
        const latest = request.messages.at(-1);
        if (latest?.role === "user") {
          yield { type: "tool_call_start", id: "shell-card", name: "run_shell" };
          yield {
            type: "tool_call_delta",
            id: "shell-card",
            json: JSON.stringify({
              command: "printf shell-card-fixture-with-bounded-secondary-provenance-and-wide-tail",
            }),
          };
          yield { type: "tool_call_end", id: "shell-card" };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: "Shell card complete." };
      } else if (options.scenario === "tool-artifact") {
        const latest = request.messages.at(-1);
        if (latest?.role === "user") {
          await writeFile(
            join(options.controlRoot as string, "tool-artifact-requested"),
            "requested\n",
            "utf8",
          );
          const command = "yes x | head -c 70000";
          yield { type: "tool_call_start", id: "shell-artifact", name: "run_shell" };
          yield {
            type: "tool_call_delta",
            id: "shell-artifact",
            json: JSON.stringify({ command }),
          };
          yield { type: "tool_call_end", id: "shell-artifact" };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        await writeFile(
          join(options.controlRoot as string, "tool-artifact-result"),
          JSON.stringify(latest),
          "utf8",
        );
        yield { type: "text_delta", text: "Tool artifact complete." };
      } else if (options.scenario === "provider-usage") {
        yield { type: "text_delta", text: "Provider usage answer." };
        yield { type: "usage", inputTokens: 12_345, outputTokens: 99 };
      } else if (options.scenario === "provider-no-usage") {
        yield { type: "text_delta", text: "Provider usage unavailable." };
      } else if (options.scenario === "skill-selection") {
        yield { type: "text_delta", text: "Skill selection complete." };
      } else if (
        options.scenario === "artifact-backed-assistant" ||
        options.scenario === "artifact-page-race"
      ) {
        artifactResponseOrdinal += 1;
        const responseIdentity =
          options.scenario === "artifact-backed-assistant" && artifactResponseOrdinal === 2
            ? "c"
            : "";
        yield {
          type: "text_delta",
          text: `Assistant artifact page one\n${"a".repeat(20_000)}\nAssistant artifact page two\n${"b".repeat(250_000)}${responseIdentity}`,
        };
      } else if (options.scenario === "copy-large-assistant") {
        yield {
          type: "text_delta",
          text: `${"c".repeat(65 * 1024)}\nExact copy tail.`,
        };
      } else if (options.scenario === "copy-older-assistant") {
        const latestUser = [...request.messages]
          .reverse()
          .find((message) => message.role === "user");
        if (latestUser?.role === "user" && latestUser.content === "Older copy prompt") {
          yield { type: "text_delta", text: "Older copy answer." };
        }
      } else if (options.scenario === "unsafe-output") {
        yield {
          type: "text_delta",
          text: "\u001b]52;c;YXR0YWNr\u0007Visible \u001b[2Janswer.",
        };
      } else if (
        options.scenario === "reasoning-artifact" ||
        options.scenario === "reasoning-artifact-race" ||
        options.scenario === "reasoning-artifact-reorder" ||
        options.scenario === "reasoning-artifact-session-race"
      ) {
        yield {
          type: "reasoning_start",
          id: "provider-reasoning-0",
          artifactType: "provider_reasoning",
        };
        yield {
          type: "reasoning_delta",
          id: "provider-reasoning-0",
          text: `Artifact reasoning evidence\n${"r".repeat(270_000)}`,
        };
        yield { type: "reasoning_end", id: "provider-reasoning-0" };
        yield { type: "text_delta", text: "Artifact reasoning answer." };
      } else if (
        options.scenario === "reasoning-cancellation" ||
        options.scenario === "reasoning-failure"
      ) {
        yield {
          type: "reasoning_start",
          id: "provider-reasoning-0",
          artifactType: "provider_reasoning",
        };
        yield {
          type: "reasoning_delta",
          id: "provider-reasoning-0",
          text: "Inspect terminal state.",
        };
        if (options.scenario === "reasoning-failure") {
          throw new ModelDriverError("transport", "The reasoning fixture failed.", {
            cause: new Error("reasoning fixture transport failure"),
          });
        }
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) {
            resolve();
            return;
          }
          request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw request.signal.reason;
      } else if (options.scenario === "reasoning-large-live") {
        yield {
          type: "reasoning_start",
          id: "provider-reasoning-0",
          artifactType: "provider_reasoning",
        };
        yield {
          type: "reasoning_delta",
          id: "provider-reasoning-0",
          text: `Live large reasoning head\n${"l".repeat(255 * 1024)}`,
        };
        await writeFile(
          join(options.controlRoot as string, "reasoning-large-ready"),
          "ready\n",
          "utf8",
        );
        if (
          !(await waitForFile(
            options.controlRoot as string,
            "release-reasoning-large-growth",
            request.signal,
          ))
        ) {
          throw request.signal.reason;
        }
        yield {
          type: "reasoning_delta",
          id: "provider-reasoning-0",
          text: `\nLive large reasoning crossed threshold\n${"g".repeat(3 * 1024)}`,
        };
        await writeFile(
          join(options.controlRoot as string, "reasoning-large-grown"),
          "grown\n",
          "utf8",
        );
        if (
          !(await waitForFile(
            options.controlRoot as string,
            "release-reasoning-large-completion",
            request.signal,
          ))
        ) {
          throw request.signal.reason;
        }
        yield { type: "reasoning_end", id: "provider-reasoning-0" };
        yield { type: "text_delta", text: "Large live reasoning answer." };
        await writeFile(
          join(options.controlRoot as string, "reasoning-large-completed"),
          "completed\n",
          "utf8",
        );
      } else if (options.scenario === "reasoning-live-viewport") {
        yield {
          type: "reasoning_start",
          id: "provider-reasoning-0",
          artifactType: "provider_reasoning",
        };
        yield {
          type: "reasoning_delta",
          id: "provider-reasoning-0",
          text: Array.from(
            { length: 30 },
            (_, index) => `Reasoning live line ${String(index + 1).padStart(2, "0")}`,
          ).join("\n"),
        };
        await writeFile(
          join(options.controlRoot as string, "reasoning-live-ready"),
          "ready\n",
          "utf8",
        );
        if (
          !(await waitForFile(options.controlRoot as string, "release-live-growth", request.signal))
        ) {
          throw request.signal.reason;
        }
        yield {
          type: "reasoning_delta",
          id: "provider-reasoning-0",
          text: `\n${Array.from(
            { length: 10 },
            (_, index) => `Reasoning live line ${String(index + 31).padStart(2, "0")}`,
          ).join("\n")}`,
        };
        await writeFile(
          join(options.controlRoot as string, "reasoning-live-grown"),
          "grown\n",
          "utf8",
        );
        if (
          !(await waitForFile(
            options.controlRoot as string,
            "release-live-completion",
            request.signal,
          ))
        ) {
          throw request.signal.reason;
        }
        yield { type: "reasoning_end", id: "provider-reasoning-0" };
        yield { type: "text_delta", text: "Live reasoning answer." };
        await writeFile(
          join(options.controlRoot as string, "reasoning-live-completed"),
          "completed\n",
          "utf8",
        );
      } else if (options.scenario === "reasoning-streaming") {
        yield {
          type: "reasoning_start",
          id: "provider-reasoning-0",
          artifactType: "provider_reasoning",
        };
        yield {
          type: "reasoning_delta",
          id: "provider-reasoning-0",
          text: "Inspect ",
        };
        await writeFile(join(options.controlRoot as string, "model-started"), "started\n", "utf8");
        if (
          !(await waitForFile(options.controlRoot as string, "release-reasoning", request.signal))
        ) {
          throw request.signal.reason;
        }
        yield {
          type: "reasoning_delta",
          id: "provider-reasoning-0",
          text: "the evidence.",
        };
        if (!(await waitForFile(options.controlRoot as string, "release-model", request.signal))) {
          throw request.signal.reason;
        }
        yield { type: "reasoning_end", id: "provider-reasoning-0" };
        yield { type: "text_delta", text: "Reasoning answer." };
      } else if (
        options.scenario === "reasoning-multiple" ||
        options.scenario === "reasoning-large-multiple"
      ) {
        reasoningViewportOrdinal += 1;
        yield {
          type: "reasoning_start",
          id: "provider-reasoning-0",
          artifactType: "provider_reasoning",
        };
        yield {
          type: "reasoning_delta",
          id: "provider-reasoning-0",
          text:
            options.scenario === "reasoning-large-multiple"
              ? `Large reasoning block ${reasoningViewportOrdinal}\n${String(
                  reasoningViewportOrdinal,
                ).repeat(270_000)}`
              : Array.from(
                  { length: 8 },
                  (_, index) =>
                    `Reasoning block ${reasoningViewportOrdinal} line ${String(index + 1).padStart(2, "0")}`,
                ).join("\n"),
        };
        yield { type: "reasoning_end", id: "provider-reasoning-0" };
        yield {
          type: "text_delta",
          text: `Multiple reasoning answer ${reasoningViewportOrdinal}.`,
        };
      } else if (options.scenario === "reasoning-viewport") {
        reasoningViewportOrdinal += 1;
        yield {
          type: "reasoning_start",
          id: "provider-reasoning-0",
          artifactType: "provider_reasoning",
        };
        for (let index = 0; index < 40; index += 1) {
          yield {
            type: "reasoning_delta",
            id: "provider-reasoning-0",
            text: `${index === 0 ? "" : "\n"}Reasoning viewport turn ${reasoningViewportOrdinal} line ${String(index + 1).padStart(2, "0")}`,
          };
        }
        yield { type: "reasoning_end", id: "provider-reasoning-0" };
        yield {
          type: "text_delta",
          text: `Reasoning viewport answer ${reasoningViewportOrdinal}.`,
        };
      } else {
        await writeFile(join(options.controlRoot as string, "model-started"), "started\n", "utf8");
        if (!(await waitForFile(options.controlRoot as string, "release-model", request.signal))) {
          throw request.signal.reason;
        }
        yield {
          type: "text_delta",
          text: `# Streaming answer\n\n**Markdown ready.**\n\nThinking policy: ${request.thinkingPolicy?.requestedLevelId ?? "none"}.`,
        };
      }
      yield { type: "finish", reason: "stop" };
    },
  };
  return {
    async resolve(input) {
      if (
        options.scenario === "draft-admission-cancellation" &&
        options.controlRoot !== undefined
      ) {
        await writeFile(join(options.controlRoot, "model-resolve-pending"), "pending\n", "utf8");
        if (!(await waitForFile(options.controlRoot, "release-model-resolve", input.signal))) {
          throw new Error("The draft admission target resolution was cancelled.");
        }
      }
      const identity =
        launchTargetIdentities.find((candidate) => candidate.targetId === input.targetId) ??
        (input.targetId === alternateTargetIdentity.targetId
          ? alternateTargetIdentity
          : targetIdentity);
      const thinkingCapability =
        options.launch !== undefined ||
        options.scenario === "streaming" ||
        options.scenario === "reasoning-streaming"
          ? fixtureThinkingCapabilities.get(identity.targetId)
          : undefined;
      return {
        identity,
        driver: model,
        contextProfile:
          identity.profileVersion >= 2 || identity.modelId === "deepseek-v4-flash-vision-exp"
            ? preparedDirectDeepSeekV2ContextProfile
            : contextProfile,
        ...(identity.modelId === "deepseek-v4-flash-vision-exp"
          ? {
              modalityProfile: {
                profileVersion: 1 as const,
                explicitUserImages: "supported" as const,
                imageToolResults: "unsupported" as const,
              },
              upstreamLifecycle: "experimental" as const,
            }
          : {}),
        ...(thinkingCapability === undefined ? {} : { thinkingCapability }),
      };
    },
    async snapshot() {
      if (options.launch !== undefined) {
        return {
          targets: [
            ...launchTargetIdentities.map((identity) => ({
              identity,
              catalog: fixtureCatalogMetadata(identity),
              readiness: {
                status: "available" as const,
                credentialSource: "deterministic launch fixture",
              },
              contextProfile: preparedDirectDeepSeekV2ContextProfile,
              thinkingCapability: requireFixtureThinkingCapability(identity.targetId),
              connectionTest: "supported" as const,
              ...(identity.modelId === "deepseek-v4-flash-vision-exp"
                ? {
                    modalityProfile: {
                      profileVersion: 1 as const,
                      explicitUserImages: "supported" as const,
                      imageToolResults: "unsupported" as const,
                    },
                    upstreamLifecycle: "experimental" as const,
                  }
                : {}),
            })),
            ...(options.scenario === "target-unavailable"
              ? [
                  {
                    identity: alternateTargetIdentity,
                    catalog: fixtureCatalogMetadata(alternateTargetIdentity),
                    readiness: {
                      status: "missing" as const,
                      credentialSource: "UNAVAILABLE_TEST_KEY",
                    },
                    contextProfile,
                  },
                ]
              : []),
            ...(options.scenario === "target-picker-hostile"
              ? [
                  {
                    identity: hostileTargetIdentity,
                    catalog: fixtureCatalogMetadata(hostileTargetIdentity),
                    readiness: {
                      status: "available" as const,
                      credentialSource: "目录凭据\u001b]52;c;YXR0YWNr\u0007HOSTILE_TEST_KEY",
                    },
                    contextProfile: preparedDirectDeepSeekV2ContextProfile,
                    upstreamLifecycle: "stable" as const,
                  },
                ]
              : []),
          ],
        };
      }
      return {
        targets: [
          {
            identity: targetIdentity,
            catalog: fixtureCatalogMetadata(targetIdentity),
            readiness: { status: "available", credentialSource: "deterministic TUI fixture" },
            contextProfile,
            ...(options.scenario === "streaming" || options.scenario === "reasoning-streaming"
              ? { thinkingCapability: requireFixtureThinkingCapability(targetIdentity.targetId) }
              : {}),
          },
          ...(options.scenario === "target-navigation" ||
          options.scenario === "target-navigation-unavailable"
            ? [
                {
                  identity: alternateTargetIdentity,
                  catalog: fixtureCatalogMetadata(alternateTargetIdentity),
                  readiness: {
                    status:
                      options.scenario === "target-navigation-unavailable"
                        ? ("missing" as const)
                        : ("available" as const),
                    credentialSource:
                      options.scenario === "target-navigation-unavailable"
                        ? "UNAVAILABLE_TRANSITION_KEY"
                        : "deterministic alternate TUI fixture",
                  },
                  contextProfile,
                },
              ]
            : []),
        ],
      };
    },
    async testConnection(input) {
      input.signal.throwIfAborted();
      if (
        (options.scenario === "target-connection-pending" ||
          options.scenario === "target-connection-multiple") &&
        options.controlRoot !== undefined
      ) {
        const multiple = options.scenario === "target-connection-multiple";
        await writeFile(
          join(
            options.controlRoot,
            multiple ? `target-connection-pending-${input.targetId}` : "target-connection-pending",
          ),
          `${input.targetId}\n`,
          "utf8",
        );
        if (
          !(await waitForFile(
            options.controlRoot,
            multiple ? `release-target-connection-${input.targetId}` : "release-target-connection",
            input.signal,
          ))
        ) {
          throw input.signal.reason;
        }
      }
      return input.targetId.startsWith("deepseek-")
        ? { status: "reachable", diagnostic: null }
        : {
            status: "unreachable",
            diagnostic: {
              code: "connection_unsupported",
              message: "The deterministic fixture target has no connection test.",
            },
          };
    },
  };
}

function fixtureCatalogMetadata(identity: ModelTargetIdentity) {
  if (identity.modelId === "deepseek-v4-flash") {
    return {
      displayName: "DeepSeek V4 Flash",
      summary: "Fast general-purpose coding model.",
      capabilities: ["reasoning", "tool-use"] as const,
      modalities: ["text"] as const,
      recommended: true,
    };
  }
  if (identity.modelId === "deepseek-v4-pro") {
    return {
      displayName: "DeepSeek V4 Pro",
      summary: "Higher-capability coding model for complex work.",
      capabilities: ["reasoning", "tool-use"] as const,
      modalities: ["text"] as const,
      recommended: false,
    };
  }
  if (identity.modelId === "deepseek-v4-flash-vision-exp") {
    return {
      displayName: "DeepSeek V4 Flash Vision",
      summary: "Vision-capable coding model for image-aware work.",
      capabilities: ["reasoning", "tool-use"] as const,
      modalities: ["text", "image"] as const,
      recommended: false,
    };
  }
  if (identity.modelId === "fake-local") {
    return {
      displayName: "Deterministic local model",
      summary: "Deterministic current model used by the production TUI fixture.",
      capabilities: ["tool-use"] as const,
      modalities: ["text"] as const,
      recommended: false,
    };
  }
  if (identity.modelId === "fake-other") {
    return {
      displayName: "Deterministic alternate model",
      summary: "Deterministic model target used by the production TUI fixture.",
      capabilities: ["tool-use"] as const,
      modalities: ["text"] as const,
      recommended: false,
    };
  }
  if (identity.modelId === "fixture-hostile-catalog") {
    return {
      displayName: "超长目录模型名称不会被裁剪 Alpha\u001b]52;c;YXR0YWNr\u0007",
      summary: "目录权威摘要包含中文且控制序列必须保持惰性。\u001b[31munsafe\u001b[0m",
      capabilities: ["tool-use"] as const,
      modalities: ["text"] as const,
      recommended: false,
    };
  }
  throw new TypeError(`The fixture catalog metadata for ${identity.targetId} is unavailable.`);
}

function requireLaunchTargetIdentity(targetId: string): ModelTargetIdentity {
  const identity = launchTargetIdentities.find((candidate) => candidate.targetId === targetId);
  if (identity === undefined) {
    throw new TypeError(`The launch fixture target ${targetId} is unavailable.`);
  }
  return identity;
}

function requireFixtureThinkingCapability(targetId: string) {
  const capability = fixtureThinkingCapabilities.get(targetId);
  if (capability === undefined) {
    throw new TypeError(`The launch fixture thinking capability ${targetId} is unavailable.`);
  }
  return capability;
}

function previewReadBarrier(options: {
  readonly controlRoot?: string;
  readonly scenario?: string;
}): PresentationArtifactReadBarrier | undefined {
  if (
    (options.scenario !== "mutation-delayed-preview" &&
      options.scenario !== "artifact-page-race" &&
      options.scenario !== "reasoning-artifact-race" &&
      options.scenario !== "reasoning-artifact-reorder" &&
      options.scenario !== "reasoning-artifact-session-race") ||
    options.controlRoot === undefined
  ) {
    return undefined;
  }
  let readCount = 0;
  return {
    async beforeRead() {
      readCount += 1;
      if (
        options.scenario === "reasoning-artifact-race" ||
        options.scenario === "reasoning-artifact-session-race"
      ) {
        if (readCount === 1) {
          await writeFile(
            join(options.controlRoot as string, "reasoning-page-read-pending"),
            "pending\n",
          );
          await waitForFile(options.controlRoot as string, "release-reasoning-page-read");
        }
        return;
      }
      if (options.scenario === "reasoning-artifact-reorder") {
        if (readCount === 3) {
          await writeFile(
            join(options.controlRoot as string, "reasoning-page-3-pending"),
            "pending\n",
          );
          await waitForFile(options.controlRoot as string, "release-reasoning-page-3");
        }
        return;
      }
      if (options.scenario === "artifact-page-race") {
        if (readCount === 1) {
          return;
        }
        await writeFile(join(options.controlRoot as string, "page-read-pending"), "pending\n");
        await waitForFile(options.controlRoot as string, "release-page-read");
        return;
      }
      await writeFile(join(options.controlRoot as string, "preview-requested"), "requested\n");
      await waitForFile(options.controlRoot as string, "release-preview");
    },
    async afterRead() {
      if (options.scenario === "artifact-page-race") {
        return;
      }
      await writeFile(join(options.controlRoot as string, "preview-read-complete"), "complete\n");
    },
  };
}

function clipboardAdapter(options: {
  readonly controlRoot?: string;
  readonly scenario?: string;
}): ClipboardAdapter | undefined {
  if (options.controlRoot === undefined) {
    return undefined;
  }
  if (options.scenario === "clipboard-timeout") {
    return {
      async close() {
        await writeFile(join(options.controlRoot as string, "clipboard-closed"), "closed\n");
      },
      async writeText() {
        await writeFile(join(options.controlRoot as string, "clipboard-started"), "started\n");
        return new Promise(() => undefined);
      },
    };
  }
  if (
    options.scenario !== "clipboard-success" &&
    options.scenario !== "copy-large-assistant" &&
    options.scenario !== "copy-older-assistant" &&
    options.scenario !== "artifact-backed-assistant" &&
    options.scenario !== "reasoning-streaming" &&
    options.scenario !== "read" &&
    options.scenario !== "history" &&
    options.scenario !== "session-selection-history" &&
    options.scenario !== "unsafe-history"
  ) {
    return undefined;
  }
  return {
    async writeText(text) {
      await writeFile(join(options.controlRoot as string, "clipboard.txt"), text, "utf8");
      return "copied";
    },
  };
}

function controlledDeadlineScheduler(options: {
  readonly controlRoot?: string;
  readonly scenario?: string;
}): DeadlineScheduler | undefined {
  if (
    options.controlRoot === undefined ||
    (options.scenario !== "deadline" && options.scenario !== "clipboard-timeout")
  ) {
    return undefined;
  }
  const ordinals = new Map<number, number>();
  return {
    schedule(delayMilliseconds, onDeadline) {
      const ordinal = (ordinals.get(delayMilliseconds) ?? 0) + 1;
      ordinals.set(delayMilliseconds, ordinal);
      const controller = new AbortController();
      const deadlineName = `deadline-${delayMilliseconds}-${ordinal}`;
      void waitForFile(options.controlRoot as string, deadlineName, controller.signal).then(
        (reached) => {
          if (reached) {
            onDeadline();
          }
        },
      );
      void writeFile(
        join(options.controlRoot as string, `scheduled-${deadlineName}`),
        "scheduled\n",
        "utf8",
      ).catch(() => undefined);
      return { cancel: () => controller.abort() };
    },
  };
}

async function waitForFile(
  directory: string,
  filename: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const watcher = watch(directory, { signal });
  try {
    if (await fileExists(join(directory, filename))) {
      return true;
    }
    for await (const _event of watcher) {
      if (await fileExists(join(directory, filename))) {
        return true;
      }
    }
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).name === "AbortError") {
      return false;
    }
    throw error;
  } finally {
    await watcher.return?.();
  }
}

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
