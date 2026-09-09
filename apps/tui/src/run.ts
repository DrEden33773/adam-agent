import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import {
  createModelTargets,
  createPermissionPolicy,
  createPresentationPreferences,
  createWorkspaceTrust,
  selectModelTargetId,
} from "@adam-agent/agent";
import { type TuiCommand, TuiConfigurationError } from "./command.js";
import {
  adamCommandRegistry,
  createAdamCommandRegistryFromContributions,
} from "./command-registry.js";
import { createLinuxClipboardAdapter } from "./linux-clipboard.js";
import { createProductionProjectRuntime } from "./project-runtime.js";
import { runTui } from "./tui-app.js";
import { tuiExplicitResumeFailureMessage } from "./tui-process-failure.js";

export async function run(command: Extract<TuiCommand, { type: "run" }>): Promise<void> {
  const workspaceRoot = process.cwd();
  const { XDG_CONFIG_HOME: inheritedUserConfigurationRoot } = process.env;
  const ownerConfigurationRoot =
    inheritedUserConfigurationRoot === undefined || inheritedUserConfigurationRoot.length === 0
      ? join(homedir(), ".config")
      : inheritedUserConfigurationRoot;
  const userConfigurationEnvironment: NodeJS.ProcessEnv = {
    XDG_CONFIG_HOME: isAbsolute(ownerConfigurationRoot)
      ? ownerConfigurationRoot
      : resolve(ownerConfigurationRoot),
  };
  loadProjectEnvironment();
  const { ADAM_AGENT_STATE_ROOT: configuredStateRoot } = process.env;
  const stateRoot =
    command.stateRoot ?? configuredStateRoot ?? join(homedir(), ".local", "state", "adam-agent");
  const modelTargets = createModelTargets({ environment: process.env });
  const preferences = createPresentationPreferences({
    environment: userConfigurationEnvironment,
  });
  const workspaceTrust = createWorkspaceTrust({
    environment: userConfigurationEnvironment,
    workspaceRoot,
  });
  const clipboard = createLinuxClipboardAdapter();
  const permissions = createPermissionPolicy({
    allowedEffects: ["read"],
    askedEffects: ["write", "execute", "network", "delegate", "administrative"],
  });
  const extensionPermissions = createPermissionPolicy({ allowedEffects: ["execute"] });
  const resumeSessionId = command.resumeSessionId;
  const runtime = await createProductionProjectRuntime({
    environment: userConfigurationEnvironment,
    extensionPermissions,
    modelTargets,
    permissions,
    preferences,
    projectLabel: basename(workspaceRoot),
    reservedCommandNames: adamCommandRegistry
      .entries()
      .flatMap((entry) => [entry.name, ...entry.aliases]),
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    stateRoot,
    workspaceRoot,
    workspaceTrust,
  }).catch((error) => {
    if (resumeSessionId === undefined) {
      throw error;
    }
    const message = tuiExplicitResumeFailureMessage(resumeSessionId, error);
    if (message === undefined) {
      throw error;
    }
    throw new TuiConfigurationError(message);
  });
  const commandRegistry = createAdamCommandRegistryFromContributions(runtime.contributions, {
    todoToggleKey: command.todoToggleKey,
  });
  const startupNotice = runtime.extensionAvailability.configurationUnavailable
    ? "Configured extension packages are unavailable; new extension commands are disabled."
    : runtime.extensionAvailability.rejectedCount === 0
      ? undefined
      : `${runtime.extensionAvailability.rejectedCount} configured extension${runtime.extensionAvailability.rejectedCount === 1 ? " is" : "s are"} unavailable.`;
  let runtimeCloseAttempted = false;
  const closeRuntime = async () => {
    runtimeCloseAttempted = true;
    await runtime.close();
  };
  try {
    if (resumeSessionId !== undefined) {
      const snapshot = await runtime.inspectSession(resumeSessionId).catch((error) => {
        const message = tuiExplicitResumeFailureMessage(resumeSessionId, error);
        if (message === undefined) {
          throw error;
        }
        throw new TuiConfigurationError(message);
      });
      if (snapshot.schemaVersion !== 3) {
        throw new TuiConfigurationError("The selected session cannot be opened by this TUI.");
      }
      const presentation = await runtime.createPresentation({
        sessionId: resumeSessionId,
      });
      await runTui({
        clipboard,
        todoOverlayLines: command.todoOverlayLines,
        closeRuntime,
        commandRegistry,
        mouse: command.mouse,
        presentation,
        ...(startupNotice === undefined ? {} : { startupNotice }),
        targetStatus: {
          targetId: snapshot.targetIdentity.targetId,
          certification:
            snapshot.targetIdentity.certification === "certified" ? "Certified" : "Experimental",
        },
      });
    } else {
      const {
        ADAM_AGENT_MODEL: configuredModel,
        ADAM_AGENT_PROVIDER: configuredProvider,
        ADAM_AGENT_TARGET: configuredTarget,
      } = process.env;
      const hasConfiguredTargetSelector =
        command.targetId !== undefined ||
        configuredTarget !== undefined ||
        configuredProvider !== undefined ||
        configuredModel !== undefined;
      const startupTargetId = hasConfiguredTargetSelector
        ? (command.targetId ?? selectModelTargetId(process.env))
        : undefined;
      const presentation = await runtime.createPresentation({
        openProject: true,
      });
      await runTui({
        clipboard,
        todoOverlayLines: command.todoOverlayLines,
        closeRuntime,
        commandRegistry,
        mouse: command.mouse,
        presentation,
        ...(startupNotice === undefined ? {} : { startupNotice }),
        ...(startupTargetId === undefined ? {} : { startupTargetId }),
      });
    }
  } finally {
    if (!runtimeCloseAttempted) {
      await runtime.close();
    }
  }
}

function loadProjectEnvironment(): void {
  try {
    process.loadEnvFile(join(process.cwd(), ".env"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw new TuiConfigurationError("Adam Agent could not load the project .env file.");
  }
}
