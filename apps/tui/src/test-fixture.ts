import { access, watch, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ContextProfile,
  createPermissionPolicy,
  createPresentationPreferences,
  createPresentationSession,
  createSessionLifecycle,
  type ModelDriver,
  type ModelTargetIdentity,
  type ModelTargets,
} from "@adam-agent/agent";
import {
  mcpCloseConfirmation,
  type PresentationArtifactReadBarrier,
  preparedDirectDeepSeekV2ContextProfile,
  presentationArtifactReadBarrier,
  presentationHistoryPageSize,
} from "@adam-agent/agent/internal-testing";
import type { PresentationSession } from "@adam-agent/presentation";
import type { Terminal } from "@earendil-works/pi-tui";
import { type FixtureScenario, isFixtureScenario } from "./fixture-scenario.js";
import { requireConfirmedLifecycleClose } from "./lifecycle-close.js";
import { type ClipboardAdapter, type DeadlineScheduler, runTui } from "./tui-app.js";

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
const launchTargetIdentities: readonly ModelTargetIdentity[] = [
  {
    targetId: "deepseek-v4-flash.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-flash",
    route: "direct",
    profileVersion: 2,
    certification: "certified",
  },
  {
    targetId: "deepseek-v4-pro.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-pro",
    route: "direct",
    profileVersion: 2,
    certification: "certified",
  },
];
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
  readonly launch?: {
    readonly configRoot?: string;
    readonly seedTargetIds?: readonly string[];
    readonly startupTargetId?: string;
  };
  readonly presentationCloseMarker?: string;
  readonly scenario?: FixtureScenario;
  readonly stateRoot: string;
  readonly terminal?: Terminal;
  readonly terminalProcessMarker?: string;
  readonly workspaceRoot: string;
};

export async function runTuiFixture(options: TuiFixtureOptions): Promise<void> {
  if (options.terminalProcessMarker !== undefined) {
    await writeFile(options.terminalProcessMarker, `${process.pid}\n`, "utf8");
  }
  const modelTargets = createFixtureModelTargets(options);
  const lifecycle = createSessionLifecycle({
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
    permissions: createPermissionPolicy({
      allowedEffects: options.scenario === "tool-artifact" ? ["read", "execute"] : ["read"],
      askedEffects: ["write"],
    }),
    stateRoot: options.stateRoot,
    workspaceRoot: options.workspaceRoot,
  });

  try {
    const previewBarrier = previewReadBarrier(options);
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
    const resumedSessionId =
      options.scenario === "resume" ||
      options.scenario === "history" ||
      options.scenario === "artifact-history" ||
      options.scenario === "copy-older-assistant" ||
      options.scenario === "target-navigation" ||
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
            } else if (options.scenario === "resume") {
              await lifecycle.continue({
                sessionId: created.sessionId,
                input: { text: "Resume transcript" },
              });
            } else if (options.scenario === "target-navigation") {
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
            ...(modelTargets === undefined ? {} : { modelTargets }),
            openProject: true,
            preferences: createPresentationPreferences({
              environment: {
                ...process.env,
                ...(options.launch.configRoot === undefined
                  ? {}
                  : { XDG_CONFIG_HOME: options.launch.configRoot }),
              },
            }),
            projectLabel: "workspace",
            stateRoot: options.stateRoot,
            workspaceRoot: options.workspaceRoot,
          }
        : options.scenario === "session-selection-history"
          ? {
              lifecycle,
              ...(modelTargets === undefined ? {} : { modelTargets }),
              openProject: true,
              projectLabel: "workspace",
              stateRoot: options.stateRoot,
              workspaceRoot: options.workspaceRoot,
            }
          : resumedSessionId === undefined
            ? {
                lifecycle,
                ...(modelTargets === undefined ? {} : { modelTargets }),
                projectLabel: "workspace",
                stateRoot: options.stateRoot,
                targetIdentity,
                workspaceRoot: options.workspaceRoot,
                ...(previewBarrier === undefined
                  ? {}
                  : { [presentationArtifactReadBarrier]: previewBarrier }),
              }
            : {
                lifecycle,
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
              },
    );
    const clipboard = options.clipboard ?? clipboardAdapter(options);
    const deadlineScheduler = controlledDeadlineScheduler(options);
    const tuiPresentation = observeTuiDispatch(presentation, options);
    await runTui({
      ...(clipboard === undefined ? {} : { clipboard }),
      ...(deadlineScheduler === undefined ? {} : { deadlineScheduler }),
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
      ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    });
  } finally {
    requireConfirmedLifecycleClose(await lifecycle.close());
    if (options.controlRoot !== undefined) {
      await writeFile(join(options.controlRoot, "tui-fixture-closed"), "closed\n", "utf8");
    }
  }
}

function observeTuiDispatch(
  presentation: PresentationSession,
  options: {
    readonly controlRoot?: string;
    readonly presentationCloseMarker?: string;
    readonly scenario?: FixtureScenario;
  },
): PresentationSession {
  const controlRoot = options.controlRoot;
  const observeDispatch =
    controlRoot !== undefined &&
    (options.scenario === "mutation-delayed-preview" ||
      options.scenario === "tool-artifact" ||
      options.scenario === "artifact-backed-assistant" ||
      options.scenario === "artifact-page-race");
  if (!observeDispatch && options.presentationCloseMarker === undefined) {
    return presentation;
  }
  let artifactReadCount = 0;
  return {
    async close() {
      await presentation.close();
      if (options.presentationCloseMarker !== undefined) {
        await writeFile(options.presentationCloseMarker, "closed\n", "utf8");
      }
    },
    dispatch: async (command) => {
      const receipt = presentation.dispatch(command);
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
        artifactReadCount += 1;
        await writeFile(
          join(controlRoot as string, `artifact-read-${artifactReadCount}`),
          `${command.range?.offset ?? 0}\n`,
          "utf8",
        );
        const settled = await receipt;
        await writeFile(
          join(controlRoot as string, `artifact-read-${artifactReadCount}-settled`),
          "settled\n",
          "utf8",
        );
        return settled;
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
    subscribe: (onChange) => presentation.subscribe(onChange),
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
  await runTuiFixture(parseArguments(process.argv.slice(2)));
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
  if (options.scenario === "streaming" && options.controlRoot === undefined) {
    throw new TypeError("The streaming fixture requires --control-root.");
  }
  let artifactResponseOrdinal = 0;
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
        latestUser.content.startsWith("Seeded project session for ")
      ) {
        yield { type: "text_delta", text: "Seeded project session ready." };
        yield { type: "finish", reason: "stop" };
        return;
      }
      if (options.scenario === "read") {
        const latest = request.messages.at(-1);
        if (latest?.role === "user") {
          yield { type: "tool_call_start", id: "read-readme", name: "read_file" };
          yield { type: "tool_call_delta", id: "read-readme", json: '{"path":"README.md"}' };
          yield { type: "tool_call_end", id: "read-readme" };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: "Read complete." };
      } else if (
        options.scenario === "mutation" ||
        options.scenario === "mutation-after-release" ||
        options.scenario === "mutation-delayed-preview"
      ) {
        const latest = request.messages.at(-1);
        if (latest?.role === "user") {
          if (options.scenario === "mutation-after-release") {
            await writeFile(
              join(options.controlRoot as string, "model-started"),
              "started\n",
              "utf8",
            );
            await waitForFile(options.controlRoot as string, "release-model");
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
                  edits: [{ oldText: "before", newText: "after" }],
                },
              ],
            }),
          };
          yield { type: "tool_call_end", id: "edit-file" };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: "Edit complete." };
      } else if (options.scenario === "cancellation") {
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
      } else if (options.scenario === "target-navigation") {
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
      } else {
        await writeFile(join(options.controlRoot as string, "model-started"), "started\n", "utf8");
        await waitForFile(options.controlRoot as string, "release-model");
        yield { type: "text_delta", text: "# Streaming answer\n\n**Markdown ready.**" };
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
      return {
        identity,
        driver: model,
        contextProfile:
          identity.profileVersion === 2 ? preparedDirectDeepSeekV2ContextProfile : contextProfile,
      };
    },
    async snapshot() {
      if (options.launch !== undefined) {
        return {
          targets: launchTargetIdentities.map((identity) => ({
            identity,
            readiness: {
              status: "available" as const,
              credentialSource: "deterministic launch fixture",
            },
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
          })),
        };
      }
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic TUI fixture" },
            contextProfile,
          },
          ...(options.scenario === "target-navigation"
            ? [
                {
                  identity: alternateTargetIdentity,
                  readiness: {
                    status: "available" as const,
                    credentialSource: "deterministic alternate TUI fixture",
                  },
                  contextProfile,
                },
              ]
            : []),
        ],
      };
    },
  };
}

function requireLaunchTargetIdentity(targetId: string): ModelTargetIdentity {
  const identity = launchTargetIdentities.find((candidate) => candidate.targetId === targetId);
  if (identity === undefined) {
    throw new TypeError(`The launch fixture target ${targetId} is unavailable.`);
  }
  return identity;
}

function previewReadBarrier(options: {
  readonly controlRoot?: string;
  readonly scenario?: string;
}): PresentationArtifactReadBarrier | undefined {
  if (
    (options.scenario !== "mutation-delayed-preview" &&
      options.scenario !== "artifact-page-race") ||
    options.controlRoot === undefined
  ) {
    return undefined;
  }
  let readCount = 0;
  return {
    async beforeRead() {
      readCount += 1;
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
