#!/usr/bin/env node

import { homedir } from "node:os";
import { basename, join } from "node:path";

import {
  createBiomeExecutionAdapter,
  createExtensionHost,
  createFileArtifactStore,
  createJsonlOperationStore,
  createModelTargets,
  createPermissionPolicy,
  createPresentationPreferences,
  createPresentationSession,
  createSessionLifecycle,
  ExtensionConfigurationError,
  loadExtensionConfiguration,
  ModelTargetError,
  type SessionLifecycle,
  SessionLifecycleError,
  selectModelTargetId,
} from "@adam-agent/agent";
import {
  adamCommandRegistry,
  createAdamCommandRegistryFromContributions,
} from "./command-registry.js";
import { McpShutdownUnconfirmedError, requireConfirmedLifecycleClose } from "./lifecycle-close.js";
import { createLinuxClipboardAdapter } from "./linux-clipboard.js";
import { runTui } from "./tui-app.js";

class TuiConfigurationError extends Error {}

try {
  const command = parseCommand(process.argv.slice(2));
  if (command.type === "help") {
    process.stdout.write(`${usage()}\n`);
  } else {
    const workspaceRoot = process.cwd();
    const { ADAM_AGENT_STATE_ROOT: configuredStateRoot } = process.env;
    const stateRoot =
      command.stateRoot ?? configuredStateRoot ?? join(homedir(), ".local", "state", "adam-agent");
    const modelTargets = createModelTargets({ environment: process.env });
    const preferences = createPresentationPreferences({ environment: process.env });
    const clipboard = createLinuxClipboardAdapter();
    const permissions = createPermissionPolicy({
      allowedEffects: ["read"],
      askedEffects: ["write", "execute", "network", "delegate", "administrative"],
    });
    const extensionPermissions = createPermissionPolicy({ allowedEffects: ["execute"] });
    let extensionConfigurationUnavailable = false;
    const extensions = await loadExtensionConfiguration(process.env, { allowMissing: true }).catch(
      (error: unknown) => {
        if (
          error instanceof ExtensionConfigurationError &&
          error.code === "extension_configuration_unavailable"
        ) {
          extensionConfigurationUnavailable = true;
          return [];
        }
        throw error;
      },
    );
    const artifactStore = await createFileArtifactStore({ root: join(stateRoot, "artifacts") });
    const operationStore = await createJsonlOperationStore({ stateRoot, workspaceRoot });
    let lifecycle: SessionLifecycle | undefined;
    const host = createExtensionHost({
      artifactStore,
      biomeExecution: createBiomeExecutionAdapter(),
      capabilities: [
        { id: "adam.analyzer-execution.biome@1", version: "1.0.0" },
        { id: "adam.artifact.publish@1", version: "1.0.0" },
        { id: "adam.storage.records@1", version: "1.0.0" },
      ],
      extensions,
      operationOriginAuthority: {
        async validateBoundary({ origin, projectId }) {
          if (lifecycle === undefined) {
            return false;
          }
          const snapshot = await lifecycle.inspect({ sessionId: origin.sessionId });
          return (
            snapshot.schemaVersion === 3 &&
            snapshot.projectId === projectId &&
            origin.sourceSequence <= snapshot.lastSequence
          );
        },
      },
      operationStore,
      permissions: extensionPermissions,
      projectRoot: workspaceRoot,
      reservedCommandNames: adamCommandRegistry
        .entries()
        .flatMap((entry) => [entry.name, ...entry.aliases]),
      stateRoot,
    });
    const extensionSnapshot = await host.loadConfiguredExtensions();
    const commandRegistry = createAdamCommandRegistryFromContributions(host.listContributions());
    const rejectedExtensions = extensionSnapshot.extensions.filter(
      (extension) => extension.status === "rejected",
    ).length;
    const startupNotice = extensionConfigurationUnavailable
      ? "Configured extension packages are unavailable; new extension commands are disabled."
      : rejectedExtensions === 0
        ? undefined
        : `${rejectedExtensions} configured extension${rejectedExtensions === 1 ? " is" : "s are"} unavailable.`;
    lifecycle = createSessionLifecycle({ modelTargets, permissions, stateRoot, workspaceRoot });
    try {
      if (command.resumeSessionId !== undefined && command.targetId !== undefined) {
        throw new TuiConfigurationError("--resume and --target cannot be combined.");
      }
      if (command.resumeSessionId !== undefined) {
        const snapshot = await lifecycle.inspect({ sessionId: command.resumeSessionId });
        if (snapshot.schemaVersion !== 3) {
          throw new TuiConfigurationError("The selected session cannot be opened by this TUI.");
        }
        const presentation = await createPresentationSession({
          lifecycle,
          modelTargets,
          operations: host.operations,
          preferences,
          projectChanges: host,
          projectLabel: basename(workspaceRoot),
          sessionId: command.resumeSessionId,
          stateRoot,
          workspaceRoot,
        });
        await runTui({
          clipboard,
          commandRegistry,
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
        const presentation = await createPresentationSession({
          lifecycle,
          modelTargets,
          openProject: true,
          operations: host.operations,
          preferences,
          projectChanges: host,
          projectLabel: basename(workspaceRoot),
          stateRoot,
          workspaceRoot,
        });
        await runTui({
          clipboard,
          commandRegistry,
          presentation,
          ...(startupNotice === undefined ? {} : { startupNotice }),
          ...(startupTargetId === undefined ? {} : { startupTargetId }),
        });
      }
    } finally {
      requireConfirmedLifecycleClose(await lifecycle.close());
    }
  }
} catch (error) {
  const message =
    error instanceof TuiConfigurationError ||
    error instanceof ExtensionConfigurationError ||
    error instanceof McpShutdownUnconfirmedError ||
    error instanceof ModelTargetError ||
    error instanceof SessionLifecycleError
      ? error.message
      : "The Adam TUI could not start safely.";
  process.stderr.write(`${message}\n${usage()}\n`);
  process.exitCode = 1;
}

type TuiCommand =
  | { readonly type: "help" }
  | {
      readonly type: "run";
      readonly resumeSessionId?: string;
      readonly stateRoot?: string;
      readonly targetId?: string;
    };

function parseCommand(arguments_: readonly string[]): TuiCommand {
  if (arguments_.length === 1 && (arguments_[0] === "--help" || arguments_[0] === "-h")) {
    return { type: "help" };
  }
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
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
  }
  return {
    type: "run",
    ...(values.get("--resume") === undefined
      ? {}
      : { resumeSessionId: values.get("--resume") as string }),
    ...(values.get("--state-root") === undefined
      ? {}
      : { stateRoot: values.get("--state-root") as string }),
    ...(values.get("--target") === undefined ? {} : { targetId: values.get("--target") as string }),
  };
}

function usage(): string {
  return [
    "Adam Agent TUI",
    "",
    "Usage: adam-agent-tui [--target <exact-target-id> | --resume <session-id>] [--state-root <path>]",
    "",
    "From a source checkout:",
    "  pnpm tui",
    "  pnpm tui --target deepseek-v4-flash.direct",
    "  pnpm tui --resume <session-id>",
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
