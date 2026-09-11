import type { TodoToggleKey } from "./command-registry.js";

export class TuiConfigurationError extends Error {}

export type TuiCommand =
  | { readonly type: "help" }
  | {
      readonly type: "run";
      readonly mouse: boolean;
      readonly todoToggleKey: TodoToggleKey;
      readonly todoOverlayLines: number;
      readonly resumeSessionId?: string;
      readonly stateRoot?: string;
      readonly targetId?: string;
    };

export function parseCommand(arguments_: readonly string[]): TuiCommand {
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
      !["--resume", "--state-root", "--target", "--todo-toggle-key", "--todo-lines"].includes(
        option,
      ) ||
      values.has(option)
    ) {
      throw new TuiConfigurationError("The TUI arguments are invalid.");
    }
    values.set(option, value);
    index += 2;
  }
  const todoToggleKey = values.get("--todo-toggle-key") ?? "alt+t";
  const todoOverlayLines = Number(values.get("--todo-lines") ?? "12");
  if (
    !["alt+t", "ctrl+shift+t"].includes(todoToggleKey) ||
    !Number.isInteger(todoOverlayLines) ||
    todoOverlayLines < 3 ||
    todoOverlayLines > 12
  )
    throw new TuiConfigurationError(
      "Todo options require --todo-toggle-key alt+t|ctrl+shift+t and --todo-lines 3–12.",
    );
  if (values.has("--resume") && values.has("--target")) {
    throw new TuiConfigurationError("--resume and --target cannot be combined.");
  }
  return {
    type: "run",
    todoToggleKey: todoToggleKey as TodoToggleKey,
    todoOverlayLines,
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

export function usage(): string {
  return [
    "Adam Agent TUI",
    "",
    "Usage: adam-agent-tui [--target <exact-target-id> | --resume <session-id>] [--state-root <path>] [--no-mouse]",
    "",
    "From a local installation (Linux and Node.js 24):",
    "  adam",
    "  adam --target deepseek-v4-flash.direct",
    "",
    "From a source checkout (builds before launch):",
    "  pnpm tui",
    "  pnpm tui --target deepseek-v4-flash.direct",
    "  pnpm tui --resume <session-id>",
    "  pnpm tui --no-mouse",
    "  pnpm tui --todo-toggle-key ctrl+shift+t --todo-lines 8",
    "",
    "After pnpm build (no package manager or compilation):",
    "  node /absolute/path/to/adam-agent/apps/tui/dist/main.js",
    "Keep the intended project as the current directory. Rebuild after source changes.",
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
