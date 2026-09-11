import { writeSync } from "node:fs";

export type CliCommand =
  | { readonly type: "help" }
  | {
      readonly type: "workspace_trust";
      readonly action: "status" | "grant" | "revoke";
    }
  | { readonly type: "prompt"; readonly prompt: string; readonly skills?: readonly string[] }
  | { readonly type: "recover_operation"; readonly operationId: string }
  | { readonly type: "resume"; readonly sessionId: string; readonly continue: boolean }
  | {
      readonly type: "branch";
      readonly parentSessionId: string;
      readonly atSequence: number;
      readonly targetId?: string;
    };

export function parseCliCommand(arguments_: readonly string[]): CliCommand {
  if (arguments_.length === 1 && (arguments_[0] === "--help" || arguments_[0] === "-h")) {
    return { type: "help" };
  }
  if (arguments_[0] === "--recover-operation") {
    const operationId = arguments_[1];
    if (
      operationId === undefined ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        operationId,
      ) ||
      arguments_.length !== 2
    ) {
      return failConfiguration("Usage: adam-agent --recover-operation <operation-id>");
    }
    return { type: "recover_operation", operationId };
  }
  if (arguments_.length === 1) {
    if (arguments_[0] === "--workspace-trust-status") {
      return { type: "workspace_trust", action: "status" };
    }
    if (arguments_[0] === "--trust-workspace") {
      return { type: "workspace_trust", action: "grant" };
    }
    if (arguments_[0] === "--revoke-workspace-trust") {
      return { type: "workspace_trust", action: "revoke" };
    }
  }
  if (arguments_[0] === "--resume") {
    const sessionId = arguments_[1];
    const tail = arguments_.slice(2);
    if (
      sessionId === undefined ||
      sessionId.length === 0 ||
      (tail.length !== 0 && !(tail.length === 1 && tail[0] === "--continue"))
    ) {
      return failConfiguration("Usage: adam-agent --resume <session-id> [--continue]");
    }
    return { type: "resume", sessionId, continue: tail[0] === "--continue" };
  }
  if (arguments_[0] === "--branch") {
    const parentSessionId = arguments_[1];
    const atFlag = arguments_[2];
    const atValue = arguments_[3];
    const atSequence = Number(atValue);
    const optionalTail = arguments_.slice(4);
    const validTargetTail =
      optionalTail.length === 0 ||
      (optionalTail.length === 2 &&
        optionalTail[0] === "--target" &&
        optionalTail[1] !== undefined &&
        optionalTail[1].length > 0);
    if (
      parentSessionId === undefined ||
      parentSessionId.length === 0 ||
      atFlag !== "--at" ||
      !Number.isSafeInteger(atSequence) ||
      atSequence <= 0 ||
      !validTargetTail
    ) {
      return failConfiguration(
        "Usage: adam-agent --branch <parent-session-id> --at <event-position> [--target <target-id>]",
      );
    }
    const targetId = optionalTail[1];
    return {
      type: "branch",
      parentSessionId,
      atSequence,
      ...(targetId === undefined ? {} : { targetId }),
    };
  }
  const skills: string[] = [];
  let promptStart = 0;
  while (arguments_[promptStart] === "--skill") {
    const selection = arguments_[promptStart + 1];
    if (selection === undefined || selection === "--skill") {
      return failConfiguration("Usage: adam-agent [--skill <id-or-unique-short-name>]... <prompt>");
    }
    if (Buffer.byteLength(selection, "utf8") > 16_384 || !/^[\x20-\x7e]+$/u.test(selection)) {
      return failConfiguration(
        "Explicit Skill selections must be a bounded list of nonempty ASCII handles.",
      );
    }
    skills.push(selection);
    if (skills.length > 8) {
      return failConfiguration(
        "Explicit Skill selections must be a bounded list of nonempty ASCII handles.",
      );
    }
    promptStart += 2;
  }
  return {
    type: "prompt",
    prompt: arguments_.slice(promptStart).join(" "),
    ...(skills.length === 0 ? {} : { skills }),
  };
}

export function cliUsage(): string {
  return [
    "Adam Agent headless CLI",
    "Supports Linux source checkouts and local application packages with Node.js 24.",
    "",
    "Usage: adam-agent <prompt>",
    "       adam-agent [--skill <id-or-unique-short-name>]... <prompt>",
    "       adam-agent --resume <session-id> [--continue]",
    "       adam-agent --branch <parent-session-id> --at <event-position> [--target <target-id>]",
    "       adam-agent --recover-operation <operation-id>",
    "       adam-agent --workspace-trust-status | --trust-workspace | --revoke-workspace-trust",
    "       adam-agent --help | -h",
    "",
    "From a local installation (preserves the current project directory):",
    '  adam-cli "<prompt>"',
    "  adam",
    "",
    "From a source checkout (builds before launch):",
    '  ADAM_AGENT_TARGET=fake.local pnpm --silent adam "<prompt>"',
    "  pnpm tui",
    "",
    "After pnpm build (no package manager or compilation):",
    "  node /absolute/path/to/adam-agent/apps/cli/dist/main.js",
    "Keep the intended project as the current directory. Rebuild after source changes.",
    "",
    "--resume without --continue hydrates only; --continue explicitly starts another attempt.",
    "Final answers use stdout; approvals and errors use stderr.",
    "Approvals and built-in path confinement are not an OS, process, or network sandbox.",
    "Review every shell command before approving it.",
  ].join("\n");
}

export function failConfiguration(message: string): never {
  writeSync(2, `${message}\n`);
  process.exit(1);
}
