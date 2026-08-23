#!/usr/bin/env node

import { homedir } from "node:os";
import { basename, join } from "node:path";

import {
  createModelTargets,
  createPermissionPolicy,
  createPresentationPreferences,
  createPresentationSession,
  createSessionLifecycle,
  ModelTargetError,
  SessionLifecycleError,
  selectModelTargetId,
} from "@adam-agent/agent";

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
    const lifecycle = createSessionLifecycle({
      modelTargets,
      permissions: createPermissionPolicy({
        allowedEffects: ["read"],
        askedEffects: ["write", "execute", "network", "delegate", "administrative"],
      }),
      stateRoot,
      workspaceRoot,
    });
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
          preferences,
          projectLabel: basename(workspaceRoot),
          sessionId: command.resumeSessionId,
          stateRoot,
          workspaceRoot,
        });
        await runTui({
          clipboard,
          presentation,
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
          preferences,
          projectLabel: basename(workspaceRoot),
          stateRoot,
          workspaceRoot,
        });
        await runTui({
          clipboard,
          presentation,
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
  return "Usage: adam-agent-tui [--target <exact-target-id> | --resume <session-id>] [--state-root <path>]";
}
