#!/usr/bin/env node

import { homedir } from "node:os";
import { basename, join } from "node:path";

import {
  createModelTargets,
  createPermissionPolicy,
  createPresentationSession,
  createSessionLifecycle,
  ModelTargetError,
  SessionLifecycleError,
  selectModelTargetId,
} from "@adam-agent/agent";

import { runTui } from "./tui-app.js";

class TuiConfigurationError extends Error {}

try {
  const command = parseCommand(process.argv.slice(2));
  if (command.type === "help") {
    process.stdout.write(`${usage()}\n`);
  } else {
    const startupSignal = new AbortController().signal;
    const workspaceRoot = process.cwd();
    const { ADAM_AGENT_STATE_ROOT: configuredStateRoot } = process.env;
    const stateRoot =
      command.stateRoot ?? configuredStateRoot ?? join(homedir(), ".local", "state", "adam-agent");
    const modelTargets = createModelTargets({ environment: process.env });
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
          projectLabel: basename(workspaceRoot),
          sessionId: command.resumeSessionId,
          stateRoot,
          workspaceRoot,
        });
        await runTui({
          presentation,
          targetStatus: {
            targetId: snapshot.targetIdentity.targetId,
            certification:
              snapshot.targetIdentity.certification === "certified" ? "Certified" : "Experimental",
          },
        });
      } else {
        const targetId = command.targetId ?? selectModelTargetId(process.env);
        const targets = await modelTargets.snapshot({
          discoverGateway: false,
          signal: startupSignal,
        });
        const selected = targets.targets.find((target) => target.identity.targetId === targetId);
        if (selected === undefined) {
          throw new TuiConfigurationError(`The exact target ${targetId} is not available.`);
        }
        if (selected.readiness.status !== "available") {
          throw new TuiConfigurationError(
            `The exact target ${targetId} is missing its required credential.`,
          );
        }
        const presentation = await createPresentationSession({
          lifecycle,
          projectLabel: basename(workspaceRoot),
          stateRoot,
          targetIdentity: selected.identity,
          workspaceRoot,
        });
        await runTui({
          presentation,
          targetStatus: {
            targetId: selected.identity.targetId,
            certification:
              selected.identity.certification === "certified" ? "Certified" : "Experimental",
          },
        });
      }
    } finally {
      await lifecycle.close();
    }
  }
} catch (error) {
  const message =
    error instanceof TuiConfigurationError ||
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
