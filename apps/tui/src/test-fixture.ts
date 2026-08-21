import { access, watch, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type ContextProfile,
  createPermissionPolicy,
  createPresentationSession,
  createSessionLifecycle,
  type ModelDriver,
  type ModelTargetIdentity,
  type ModelTargets,
} from "@adam-agent/agent";
import {
  mcpCloseConfirmation,
  type PresentationArtifactReadBarrier,
  presentationArtifactReadBarrier,
  presentationHistoryPageSize,
} from "@adam-agent/agent/internal-testing";
import type { PresentationSession } from "@adam-agent/presentation";
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
const contextProfile: ContextProfile = {
  version: 1,
  contextWindowTokens: 32_768,
  maximumOutputTokens: 4_096,
  compactAtTokens: 24_576,
  postCompactTargetTokens: 8_192,
  retainedTargetTokens: 4_096,
  estimatorVersion: 1,
};

const options = parseArguments(process.argv.slice(2));
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
  permissions: createPermissionPolicy({ allowedEffects: ["read"], askedEffects: ["write"] }),
  stateRoot: options.stateRoot,
  workspaceRoot: options.workspaceRoot,
});

try {
  const previewBarrier = previewReadBarrier(options);
  if (options.scenario === "session-selection-history") {
    const selectable = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: selectable.sessionId,
      input: { text: "Selected session prompt" },
    });
  }
  const resumedSessionId =
    options.scenario === "resume" ||
    options.scenario === "history" ||
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
      : undefined;
  const presentation = await createPresentationSession(
    options.scenario === "session-selection-history"
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
            ...(options.scenario === "history" ? { [presentationHistoryPageSize]: 2 } : {}),
            ...(previewBarrier === undefined
              ? {}
              : { [presentationArtifactReadBarrier]: previewBarrier }),
          },
  );
  const clipboard = clipboardAdapter(options);
  const deadlineScheduler = controlledDeadlineScheduler(options);
  const tuiPresentation = observePermissionDecision(presentation, options);
  await runTui({
    ...(clipboard === undefined ? {} : { clipboard }),
    ...(deadlineScheduler === undefined ? {} : { deadlineScheduler }),
    presentation: tuiPresentation,
    targetStatus: { targetId: targetIdentity.targetId, certification: "Certified" },
  });
} finally {
  requireConfirmedLifecycleClose(await lifecycle.close());
}

function observePermissionDecision(
  presentation: PresentationSession,
  options: {
    readonly controlRoot?: string;
    readonly scenario?: FixtureScenario;
  },
): PresentationSession {
  const controlRoot = options.controlRoot;
  if (options.scenario !== "mutation-delayed-preview" || controlRoot === undefined) {
    return presentation;
  }
  return {
    close: () => presentation.close(),
    dispatch: async (command) => {
      const receipt = presentation.dispatch(command);
      if (command.type === "decide_permission") {
        await writeFile(
          join(controlRoot, "permission-decision-submitted"),
          `${command.decision}\n`,
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
  return {
    ...(controlRoot === undefined ? {} : { controlRoot }),
    ...(scenario === undefined ? {} : { scenario }),
    stateRoot,
    workspaceRoot,
  };
}

function optionValue(arguments_: readonly string[], option: string): string | undefined {
  const index = arguments_.indexOf(option);
  return index < 0 ? undefined : arguments_[index + 1];
}

function createFixtureModelTargets(options: {
  readonly controlRoot?: string;
  readonly scenario?: FixtureScenario;
}): ModelTargets | undefined {
  if (
    options.scenario === undefined ||
    options.scenario === "clipboard-success" ||
    options.scenario === "clipboard-timeout" ||
    options.scenario === "deadline"
  ) {
    return undefined;
  }
  if (options.scenario === "streaming" && options.controlRoot === undefined) {
    throw new TypeError("The streaming fixture requires --control-root.");
  }
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        yield { type: "text_delta", text: "Streaming session" };
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
            json: JSON.stringify({ command: "printf shell-card-fixture" }),
          };
          yield { type: "tool_call_end", id: "shell-card" };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: "Shell card complete." };
      } else if (options.scenario === "skill-selection") {
        yield { type: "text_delta", text: "Skill selection complete." };
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
      const identity =
        input.targetId === alternateTargetIdentity.targetId
          ? alternateTargetIdentity
          : targetIdentity;
      return { identity, driver: model, contextProfile };
    },
    async snapshot() {
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

function previewReadBarrier(options: {
  readonly controlRoot?: string;
  readonly scenario?: string;
}): PresentationArtifactReadBarrier | undefined {
  if (options.scenario !== "mutation-delayed-preview" || options.controlRoot === undefined) {
    return undefined;
  }
  return {
    async beforeRead() {
      await writeFile(join(options.controlRoot as string, "preview-requested"), "requested\n");
      await waitForFile(options.controlRoot as string, "release-preview");
    },
    async afterRead() {
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
      async writeText() {
        await writeFile(join(options.controlRoot as string, "clipboard-started"), "started\n");
        return new Promise(() => undefined);
      },
    };
  }
  if (
    options.scenario !== "clipboard-success" &&
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
