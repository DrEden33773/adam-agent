#!/usr/bin/env node

import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import {
  createModelTargets,
  createPermissionPolicy,
  createPresentationPreferences,
  createWorkspaceTrust,
  selectModelTargetId,
} from "@adam-agent/agent";
import {
  adamCommandRegistry,
  createAdamCommandRegistryFromContributions,
} from "./command-registry.js";
import { createLinuxClipboardAdapter } from "./linux-clipboard.js";
import { createProductionProjectRuntime } from "./project-runtime.js";
import { runTui } from "./tui-app.js";
import { TuiConfigurationError, tuiProcessFailureMessage } from "./tui-process-failure.js";

try {
  const command = parseCommand(process.argv.slice(2));
  if (command.type === "help") {
    process.stdout.write(`${usage()}\n`);
  } else {
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
      stateRoot,
      workspaceRoot,
      workspaceTrust,
    });
    const commandRegistry = createAdamCommandRegistryFromContributions(runtime.contributions);
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
      if (command.resumeSessionId !== undefined && command.targetId !== undefined) {
        throw new TuiConfigurationError("--resume and --target cannot be combined.");
      }
      if (command.resumeSessionId !== undefined) {
        const snapshot = await runtime.inspectSession(command.resumeSessionId);
        if (snapshot.schemaVersion !== 3) {
          throw new TuiConfigurationError("The selected session cannot be opened by this TUI.");
        }
        const presentation = await runtime.createPresentation({
          sessionId: command.resumeSessionId,
        });
        await runTui({
          clipboard,
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
} catch (error) {
  process.stderr.write(`${tuiProcessFailureMessage(error)}\n${usage()}\n`);
  process.exitCode = 1;
}

type TuiCommand =
  | { readonly type: "help" }
  | {
      readonly type: "run";
      readonly mouse: boolean;
      readonly resumeSessionId?: string;
      readonly stateRoot?: string;
      readonly targetId?: string;
    };

function parseCommand(arguments_: readonly string[]): TuiCommand {
  if (arguments_.length === 1 && (arguments_[0] === "--help" || arguments_[0] === "-h")) {
    return { type: "help" };
  }
  const values = new Map<string, string>();
  let mouse = true;
  let mouseOptionSeen = false;
  for (let index = 0; index < arguments_.length; ) {
    const option = arguments_[index];
    if (option === "--no-mouse") {
      if (mouseOptionSeen) {
        throw new TuiConfigurationError("The TUI arguments are invalid.");
      }
      mouse = false;
      mouseOptionSeen = true;
      index += 1;
      continue;
    }
    const value = arguments_[index + 1];
    if (
      option === undefined ||
      value === undefined ||
      (option !== "--resume" && option !== "--state-root" && option !== "--target") ||
      values.has(option)
    ) {
      throw new TuiConfigurationError("The TUI arguments are invalid.");
    }
    values.set(option, value);
    index += 2;
  }
  return {
    type: "run",
    mouse,
    ...(values.get("--resume") === undefined
      ? {}
      : { resumeSessionId: values.get("--resume") as string }),
    ...(values.get("--state-root") === undefined
      ? {}
      : { stateRoot: values.get("--state-root") as string }),
    ...(values.get("--target") === undefined ? {} : { targetId: values.get("--target") as string }),
  };
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

function usage(): string {
  return [
    "Adam Agent TUI",
    "",
    "Usage: adam-agent-tui [--target <exact-target-id> | --resume <session-id>] [--state-root <path>] [--no-mouse]",
    "",
    "From a source checkout:",
    "  pnpm tui",
    "  pnpm tui --target deepseek-v4-flash.direct",
    "  pnpm tui --resume <session-id>",
    "  pnpm tui --no-mouse",
    "",
    "Under the default policy, built-in write and execute tools require call-scoped approval.",
    "Built-in file tools reject lexical traversal and symlink escape from the workspace.",
    "Approved shell commands and trusted MCP servers run with the invoking user's authority.",
    "Extensions are trusted in-process code.",
    "Credentials remain external plaintext inputs.",
    "Session state and artifacts are owner-only local files.",
    "Adam does not provide an OS, process, or network sandbox.",
  ].join("\n");
}
