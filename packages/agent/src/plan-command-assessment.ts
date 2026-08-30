import { createHash } from "node:crypto";

// Parser and validator mechanisms are selectively adapted from
// @narumitw/pi-plan-mode@0.56.0, src/tool-policy.ts lines 314-840,
// gitHead 9b4cab310013a71d7990e7736452c3c1aebfd148, under the MIT License.
export const planShellPolicyVersions = ["plan-shell-policy.v1"] as const;
export const planGitAutomaticCommandCorpusVersion = "plan-git-corpus.v1" as const;

export type PlanShellPolicyVersion = (typeof planShellPolicyVersions)[number];

export type PlanCommandAssessment = {
  readonly status: "assessed" | "invalid";
  readonly version: 1;
  readonly policyVersion: "plan-shell-policy.v1";
  readonly disposition: "allow_inspection" | "ask_ambiguous" | "deny_mutation";
  readonly reasons: readonly (
    | "automatic_system_inspection"
    | "automatic_git_inspection"
    | "automatic_workspace_inspection"
    | "command_too_large"
    | "environment_untrusted"
    | "executable_untrusted"
    | "git_attestation_required"
    | "git_repository_untrusted"
    | "in_place_mutation"
    | "invalid_unicode"
    | "malformed_command"
    | "output_redirection"
    | "path_untrusted"
    | "recognized_mutation"
    | "shell_builtin_or_indirection"
    | "token_too_large"
    | "too_many_arguments"
    | "too_many_paths"
    | "too_many_segments"
    | "unclassified_command"
    | "unsupported_control"
    | "unsupported_syntax"
  )[];
  readonly digest: `sha256:${string}`;
};

export function assessPlanCommandV1(rawCommand: string): PlanCommandAssessment {
  if (!hasValidUnicode(rawCommand)) {
    return assessment(rawCommand, "ask_ambiguous", ["invalid_unicode"], "invalid");
  }
  if (Buffer.byteLength(rawCommand, "utf8") > 16 * 1024) {
    return assessment(rawCommand, "ask_ambiguous", ["command_too_large"], "invalid");
  }
  if (
    [...rawCommand].some((character) => {
      const code = character.codePointAt(0) as number;
      return (code < 0x20 && code !== 0x09) || code === 0x7f;
    })
  ) {
    return assessment(rawCommand, "ask_ambiguous", ["unsupported_control"], "invalid");
  }
  if (containsUnquotedOutputRedirect(rawCommand)) {
    return assessment(rawCommand, "deny_mutation", ["output_redirection"]);
  }
  const unsupportedSyntax = containsUnsupportedShellSyntax(rawCommand);
  const segments = splitCommandSegments(rawCommand);
  if (segments === undefined) {
    return unsupportedSyntax
      ? assessment(rawCommand, "ask_ambiguous", ["unsupported_syntax"])
      : assessment(rawCommand, "ask_ambiguous", ["malformed_command"], "invalid");
  }
  if (segments.length > 32) {
    return assessment(rawCommand, "ask_ambiguous", ["too_many_segments"], "invalid");
  }
  const argumentsBySegment = segments.map((segment) => tokenizeSimpleCommand(segment));
  if (
    argumentsBySegment.some((argv) =>
      argv?.some((token) => Buffer.byteLength(token, "utf8") > 4_096),
    )
  ) {
    return assessment(rawCommand, "ask_ambiguous", ["token_too_large"], "invalid");
  }
  if (argumentsBySegment.some((argv) => argv !== undefined && argv.length > 128)) {
    return assessment(rawCommand, "ask_ambiguous", ["too_many_arguments"], "invalid");
  }
  const operators = commandOperatorsV1(rawCommand);
  const classifications = argumentsBySegment.map((argv, index) =>
    classifySegment(argv, index > 0 && operators[index - 1] === "|"),
  );
  const pathOperands = classifications.flatMap((classification) => classification.pathOperands);
  if (pathOperands.length > 32) {
    return assessment(rawCommand, "ask_ambiguous", ["too_many_paths"], "invalid");
  }
  const denied = classifications.find(
    (classification) => classification.disposition === "deny_mutation",
  );
  if (denied !== undefined) {
    return assessment(rawCommand, "deny_mutation", [denied.reason]);
  }
  if (
    classifications.some(
      (classification) => classification.reason === "shell_builtin_or_indirection",
    )
  ) {
    return assessment(rawCommand, "ask_ambiguous", ["shell_builtin_or_indirection"]);
  }
  if (unsupportedSyntax) {
    return assessment(rawCommand, "ask_ambiguous", ["unsupported_syntax"]);
  }
  if (
    classifications.every((classification) => classification.disposition === "allow_inspection")
  ) {
    return assessment(rawCommand, "allow_inspection", [
      classifications.some((classification) => classification.reason === "automatic_git_inspection")
        ? "automatic_git_inspection"
        : classifications.some(
              (classification) => classification.reason === "automatic_workspace_inspection",
            )
          ? "automatic_workspace_inspection"
          : "automatic_system_inspection",
    ]);
  }
  return assessment(rawCommand, "ask_ambiguous", ["unclassified_command"]);
}

function containsUnsupportedShellSyntax(rawCommand: string): boolean {
  if (/^[\t ]*[A-Za-z_][A-Za-z0-9_]*=/u.test(rawCommand)) {
    return true;
  }
  let quote: "single" | "double" | undefined;
  let escaped = false;
  for (let index = 0; index < rawCommand.length; index += 1) {
    const character = rawCommand[index] as string;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "single") {
      escaped = true;
      continue;
    }
    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? undefined : "single";
      continue;
    }
    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? undefined : "double";
      continue;
    }
    if (quote === "single") {
      continue;
    }
    if (character === "$" || character === "`") {
      return true;
    }
    if (quote === "double") {
      continue;
    }
    if ("<#(){}*?[~".includes(character)) {
      return true;
    }
    if (character === "&" && rawCommand[index + 1] !== "&") {
      return true;
    }
    if (character === "&") {
      index += 1;
    }
  }
  return false;
}

function hasValidUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function planCommandArgumentsV1(
  rawCommand: string,
): readonly (readonly string[])[] | undefined {
  const segments = splitCommandSegments(rawCommand);
  if (segments === undefined) {
    return undefined;
  }
  const argumentsBySegment = segments.map((segment) => tokenizeSimpleCommand(segment));
  return argumentsBySegment.some((argv) => argv === undefined)
    ? undefined
    : (argumentsBySegment as readonly (readonly string[])[]);
}

export function planAutomaticPathOperandsV1(rawCommand: string): readonly string[] | undefined {
  const argumentsBySegment = planCommandArgumentsV1(rawCommand);
  if (argumentsBySegment === undefined) {
    return undefined;
  }
  const operators = commandOperatorsV1(rawCommand);
  const classifications = argumentsBySegment.map((argv, index) =>
    classifySegment(argv, index > 0 && operators[index - 1] === "|"),
  );
  return classifications.every(
    (classification) => classification.disposition === "allow_inspection",
  )
    ? classifications.flatMap((classification) => classification.pathOperands)
    : undefined;
}

export function bindPlanCommandExecutionIdentityV1(
  rawCommand: string,
  current: PlanCommandAssessment,
  executionIdentity: unknown,
): PlanCommandAssessment {
  return assessment(
    rawCommand,
    current.disposition,
    current.reasons,
    current.status,
    executionIdentity,
  );
}

export function downgradePlanCommandAssessmentV1(
  rawCommand: string,
  reason:
    | "environment_untrusted"
    | "executable_untrusted"
    | "git_attestation_required"
    | "git_repository_untrusted"
    | "path_untrusted",
  executionIdentity?: unknown,
): PlanCommandAssessment {
  return assessment(rawCommand, "ask_ambiguous", [reason], "assessed", executionIdentity);
}

function containsUnquotedOutputRedirect(rawCommand: string): boolean {
  let quote: "single" | "double" | undefined;
  let escaped = false;
  for (const character of rawCommand) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "single") {
      escaped = true;
    } else if (character === "'" && quote !== "double") {
      quote = quote === "single" ? undefined : "single";
    } else if (character === '"' && quote !== "single") {
      quote = quote === "double" ? undefined : "double";
    } else if (character === ">" && quote === undefined) {
      return true;
    }
  }
  return false;
}

function classifySegment(
  argv: readonly string[] | undefined,
  automaticPipelineInput = false,
): {
  readonly disposition: PlanCommandAssessment["disposition"];
  readonly reason: PlanCommandAssessment["reasons"][number];
  readonly pathOperands: readonly string[];
} {
  if (isDirectMutation(argv)) {
    return { disposition: "deny_mutation", reason: "recognized_mutation", pathOperands: [] };
  }
  if (isInPlaceOrOutputMutation(argv)) {
    return { disposition: "deny_mutation", reason: "in_place_mutation", pathOperands: [] };
  }
  if (argv?.[0] !== undefined && planShellBuiltinAndIndirectionV1.has(argv[0])) {
    return {
      disposition: "ask_ambiguous",
      reason: "shell_builtin_or_indirection",
      pathOperands: [],
    };
  }
  if (isSystemObservation(argv) || isVersionObservation(argv)) {
    return {
      disposition: "allow_inspection",
      reason: "automatic_system_inspection",
      pathOperands: [],
    };
  }
  const gitPaths = gitAutomaticInspectionPaths(argv);
  if (gitPaths !== undefined) {
    return {
      disposition: "allow_inspection",
      reason: "automatic_git_inspection",
      pathOperands: gitPaths,
    };
  }
  const workspacePaths = workspaceInspectionPaths(argv, automaticPipelineInput);
  if (workspacePaths !== undefined) {
    return {
      disposition: "allow_inspection",
      reason: "automatic_workspace_inspection",
      pathOperands: workspacePaths,
    };
  }
  return { disposition: "ask_ambiguous", reason: "unclassified_command", pathOperands: [] };
}

export function isPlanAutomaticGitCommandV1(argv: readonly string[]): boolean {
  return argv.length === 2 && argv[0] === "git" && argv[1] === "--version"
    ? true
    : gitAutomaticInspectionPaths(argv) !== undefined;
}

export function isPlanAutomaticRepositoryGitCommandV1(argv: readonly string[]): boolean {
  return gitAutomaticInspectionPaths(argv) !== undefined;
}

function gitAutomaticInspectionPaths(
  argv: readonly string[] | undefined,
): readonly string[] | undefined {
  if (argv?.[0] !== "git" || argv[1] !== "--no-pager") {
    return undefined;
  }
  if (
    argv[2] === "status" &&
    (argv.length === 6 || argv.length === 7) &&
    argv[3] === "--porcelain=v1" &&
    argv[4] === "--untracked-files=normal" &&
    argv[5] === "--ignore-submodules=all" &&
    (argv.length === 6 || argv[6] === "--branch")
  ) {
    return [];
  }
  if (
    argv[2] === "rev-parse" &&
    ((argv.length === 4 &&
      ["--show-toplevel", "--is-inside-work-tree", "--show-prefix"].includes(argv[3] as string)) ||
      (argv.length === 5 && argv[3] === "--verify" && argv[4] === "HEAD"))
  ) {
    return [];
  }
  if (
    argv.length === 7 &&
    argv[2] === "log" &&
    argv[3] === "--oneline" &&
    argv[4] === "--decorate=no" &&
    argv[5] === "-n" &&
    isBoundedPositiveDecimal(argv[6])
  ) {
    return [];
  }
  const gitReadPrefix = ["--no-ext-diff", "--no-textconv", "--ignore-submodules=all"];
  if (
    argv[2] === "diff" &&
    argv.slice(3, 6).every((argument, index) => argument === gitReadPrefix[index])
  ) {
    let index = 6;
    if (["--stat", "--name-only", "--name-status"].includes(argv[index] as string)) {
      index += 1;
    }
    if (argv[index] === "--cached") {
      index += 1;
    }
    if (index === argv.length) {
      return [];
    }
    return argv[index] === "--" && index + 1 < argv.length ? argv.slice(index + 1) : undefined;
  }
  if (
    argv[2] === "show" &&
    argv.slice(3, 6).every((argument, index) => argument === gitReadPrefix[index]) &&
    argv.length === 8 &&
    ["--stat", "--name-only", "--name-status"].includes(argv[6] as string) &&
    (argv[7] === "HEAD" || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(argv[7] as string))
  ) {
    return [];
  }
  return undefined;
}

function workspaceInspectionPaths(
  argv: readonly string[] | undefined,
  automaticPipelineInput = false,
): readonly string[] | undefined {
  if (argv === undefined) {
    return undefined;
  }
  if (argv[0] === "ls") {
    let index = 1;
    if (["-1", "-a", "-A"].includes(argv[index] as string)) {
      index += 1;
    }
    if (argv[index] === "--") {
      index += 1;
    }
    const paths = argv.slice(index);
    return paths.some((path) => path.startsWith("-")) ? undefined : paths;
  }
  if (
    argv[0] === "stat" &&
    argv.length >= 5 &&
    argv[1] === "-c" &&
    argv[2] === "%f %s %Y" &&
    argv[3] === "--"
  ) {
    return argv.slice(4);
  }
  if (
    (argv[0] === "head" || argv[0] === "tail") &&
    argv.length >= 5 &&
    argv[1] === "-n" &&
    isBoundedPositiveDecimal(argv[2]) &&
    argv[3] === "--"
  ) {
    return argv.slice(4);
  }
  if (
    argv[0] === "wc" &&
    argv.length >= 4 &&
    ["-l", "-w", "-c"].includes(argv[1] as string) &&
    argv[2] === "--"
  ) {
    return argv.slice(3);
  }
  if (argv[0] === "rg") {
    const prefix = ["--no-config", "--no-follow", "--line-number", "--fixed-strings"];
    if (argv.slice(1, 5).some((argument, index) => argument !== prefix[index])) {
      return undefined;
    }
    let index = 5;
    if (argv[index] === "--ignore-case" || argv[index] === "--case-sensitive") {
      index += 1;
    }
    return argv[index] === "--" && argv.length >= index + 3 ? argv.slice(index + 2) : undefined;
  }
  if (argv[0] === "grep" && argv[1] === "-nF") {
    let index = 2;
    if (argv[index] === "-i") {
      index += 1;
    }
    if (argv[index] !== "--") {
      return undefined;
    }
    if (argv.length >= index + 3) {
      return argv.slice(index + 2);
    }
    return automaticPipelineInput && argv.length === index + 2 ? [] : undefined;
  }
  if (
    argv.length === 9 &&
    argv[0] === "find" &&
    argv[2] === "-maxdepth" &&
    isBoundedNonnegativeDecimal(argv[3], 32) &&
    argv[4] === "-type" &&
    argv[5] === "f" &&
    (argv[6] === "-name" || argv[6] === "-iname") &&
    argv[8] === "-print"
  ) {
    return [argv[1] as string];
  }
  return undefined;
}

function commandOperatorsV1(rawCommand: string): readonly ("|" | "||" | "&&" | ";")[] {
  const operators: Array<"|" | "||" | "&&" | ";"> = [];
  let quote: "single" | "double" | undefined;
  let escaped = false;
  for (let index = 0; index < rawCommand.length; index += 1) {
    const character = rawCommand[index] as string;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "single") {
      escaped = true;
    } else if (character === "'" && quote !== "double") {
      quote = quote === "single" ? undefined : "single";
    } else if (character === '"' && quote !== "single") {
      quote = quote === "double" ? undefined : "double";
    } else if (quote === undefined && character === ";") {
      operators.push(";");
    } else if (quote === undefined && character === "|") {
      if (rawCommand[index + 1] === "|") {
        operators.push("||");
        index += 1;
      } else {
        operators.push("|");
      }
    } else if (quote === undefined && character === "&" && rawCommand[index + 1] === "&") {
      operators.push("&&");
      index += 1;
    }
  }
  return operators;
}

function isBoundedPositiveDecimal(value: string | undefined): boolean {
  return value !== undefined && /^(?:[1-9]|[1-9]\d|1\d\d|200)$/u.test(value);
}

function isBoundedNonnegativeDecimal(value: string | undefined, maximum: number): boolean {
  return value !== undefined && /^(?:0|[1-9]\d*)$/u.test(value) && Number(value) <= maximum;
}

export const planShellBuiltinAndIndirectionV1: ReadonlySet<string> = new Set([
  "!",
  ".",
  ":",
  "[",
  "alias",
  "bg",
  "break",
  "builtin",
  "case",
  "cd",
  "command",
  "continue",
  "do",
  "done",
  "echo",
  "elif",
  "else",
  "env",
  "esac",
  "eval",
  "exec",
  "exit",
  "export",
  "false",
  "fc",
  "fg",
  "fi",
  "for",
  "getopts",
  "hash",
  "if",
  "in",
  "jobs",
  "kill",
  "local",
  "printf",
  "pwd",
  "read",
  "readonly",
  "return",
  "set",
  "shift",
  "test",
  "then",
  "times",
  "trap",
  "true",
  "type",
  "ulimit",
  "umask",
  "unalias",
  "unset",
  "until",
  "wait",
  "while",
  "xargs",
  "{",
  "}",
]);

function isDirectMutation(argv: readonly string[] | undefined): boolean {
  const command = argv?.[0];
  if (command === undefined || argv === undefined) {
    return false;
  }
  if (
    [
      "chattr",
      "chgrp",
      "chmod",
      "chown",
      "cp",
      "crontab",
      "dd",
      "doas",
      "ed",
      "emacs",
      "ex",
      "install",
      "kill",
      "killall",
      "ln",
      "mkdir",
      "mkfifo",
      "mknod",
      "mount",
      "mv",
      "nano",
      "patch",
      "pkill",
      "reboot",
      "rm",
      "rmdir",
      "rsync",
      "service",
      "setfacl",
      "shutdown",
      "shred",
      "su",
      "sudo",
      "systemctl",
      "tee",
      "touch",
      "truncate",
      "umount",
      "unlink",
      "vi",
      "vim",
    ].includes(command)
  ) {
    return true;
  }
  if (command === "git") {
    const subcommandIndex = gitSubcommandIndex(argv);
    if (subcommandIndex === undefined) {
      return false;
    }
    const subcommand = argv[subcommandIndex];
    const subcommandArguments = argv.slice(subcommandIndex + 1);
    if (
      subcommand !== undefined &&
      [
        "add",
        "am",
        "apply",
        "bisect",
        "branch",
        "checkout",
        "cherry-pick",
        "clean",
        "clone",
        "commit",
        "config",
        "fetch",
        "format-patch",
        "gc",
        "init",
        "ls-remote",
        "maintenance",
        "merge",
        "mergetool",
        "mv",
        "notes",
        "pack-refs",
        "prune",
        "pull",
        "push",
        "rebase",
        "reflog",
        "remote",
        "repack",
        "replace",
        "reset",
        "restore",
        "revert",
        "rm",
        "sparse-checkout",
        "stage",
        "stash",
        "submodule",
        "switch",
        "tag",
        "update-index",
        "update-ref",
        "worktree",
        "write-tree",
      ].includes(subcommand)
    ) {
      return true;
    }
    if (
      subcommand === "hash-object" &&
      subcommandArguments.some((argument) => argument === "-w" || argument === "--stdin-paths")
    ) {
      return true;
    }
  }
  if (["npm", "pnpm", "yarn", "bun", "cargo"].includes(command)) {
    if (hasPackageMutationSubcommand(command, argv)) {
      return true;
    }
  }
  if (command === "go") {
    const subcommandIndex = commandIndexAfterLeadingOptions(argv, 1, {
      valueOptions: ["-C"],
      attachedValuePrefixes: ["-C="],
    });
    if (subcommandIndex === undefined) {
      return false;
    }
    const subcommand = argv[subcommandIndex];
    const subcommandArguments = argv.slice(subcommandIndex + 1);
    if (["clean", "get", "install"].includes(subcommand as string)) {
      return true;
    }
    if (
      subcommand === "env" &&
      subcommandArguments.some((argument) => argument === "-w" || argument === "-u")
    ) {
      return true;
    }
    return (
      (subcommand === "mod" &&
        ["download", "edit", "init", "tidy", "vendor"].includes(
          subcommandArguments[0] as string,
        )) ||
      (subcommand === "work" &&
        ["edit", "init", "sync", "use"].includes(subcommandArguments[0] as string))
    );
  }
  return false;
}

function isInPlaceOrOutputMutation(argv: readonly string[] | undefined): boolean {
  if (argv === undefined) {
    return false;
  }
  const command = argv[0];
  const arguments_ = argv.slice(1);
  const optionArguments = argumentsBeforeOperandSeparator(arguments_);
  if (command === "sed" && hasSedInPlaceOption(arguments_)) {
    return true;
  }
  if (command === "perl" && hasPerlInPlaceOption(arguments_)) {
    return true;
  }
  if (command === "find" && hasFindMutationPredicate(arguments_)) {
    return true;
  }
  if (command === "sort" && hasSortOutputOption(arguments_)) {
    return true;
  }
  if (
    ["diff", "uniq"].includes(command as string) &&
    optionArguments.some(
      (argument) =>
        argument === "-o" || argument === "--output" || argument.startsWith("--output="),
    )
  ) {
    return true;
  }
  if (command === "git") {
    const subcommandIndex = gitSubcommandIndex(argv);
    if (subcommandIndex === undefined) {
      return false;
    }
    const subcommand = argv[subcommandIndex];
    return (
      ["archive", "diff", "format-patch", "log", "show"].includes(subcommand as string) &&
      argumentsBeforeOperandSeparator(argv.slice(subcommandIndex + 1)).some(
        (argument) =>
          argument === "--output" ||
          argument.startsWith("--output=") ||
          (subcommand === "archive" && argument.startsWith("-o")),
      )
    );
  }
  return false;
}

function gitSubcommandIndex(argv: readonly string[]): number | undefined {
  return commandIndexAfterLeadingOptions(argv, 1, {
    valueOptions: [
      "-C",
      "-c",
      "--config-env",
      "--exec-path",
      "--git-dir",
      "--namespace",
      "--super-prefix",
      "--work-tree",
    ],
    attachedValuePrefixes: [
      "-C",
      "-c",
      "--config-env=",
      "--exec-path=",
      "--git-dir=",
      "--namespace=",
      "--super-prefix=",
      "--work-tree=",
    ],
    flagOptions: [
      "--bare",
      "--glob-pathspecs",
      "--help",
      "--html-path",
      "--icase-pathspecs",
      "--info-path",
      "--literal-pathspecs",
      "--man-path",
      "--no-advice",
      "--no-lazy-fetch",
      "--no-optional-locks",
      "--no-pager",
      "--no-replace-objects",
      "--noglob-pathspecs",
      "--paginate",
      "--version",
      "-h",
      "-P",
      "-p",
    ],
  });
}

// Provenance: these tables freeze npm CLI 11.6.2's public command and alias surface from
// npm/cli lib/utils/cmd-list.js lines 3-177, plus @npmcli/config 10.4.2's option names,
// shorthands, and type arity from lib/definitions/index.js lines 24-60 and
// lib/definitions/definitions.js lines 87-2316. The bounded parser preserves the relevant
// equals, shorthand, unique-prefix, negation, Boolean-secondary-type, and value-consumption
// semantics of nopt 8.1.0 lib/nopt-lib.js lines 249-504 without executing npm or nopt code.
// Adam owns the position resolver, mutation classification, bounds, and fail-closed result.
// See THIRD_PARTY_NOTICES.md for exact upstream links, differences, and licenses.
const frozenNpmCommandsV1 = [
  "access",
  "adduser",
  "audit",
  "bugs",
  "cache",
  "ci",
  "completion",
  "config",
  "dedupe",
  "deprecate",
  "diff",
  "dist-tag",
  "docs",
  "doctor",
  "edit",
  "exec",
  "explain",
  "explore",
  "find-dupes",
  "fund",
  "get",
  "help",
  "help-search",
  "init",
  "install",
  "install-ci-test",
  "install-test",
  "link",
  "ll",
  "login",
  "logout",
  "ls",
  "org",
  "outdated",
  "owner",
  "pack",
  "ping",
  "pkg",
  "prefix",
  "profile",
  "prune",
  "publish",
  "query",
  "rebuild",
  "repo",
  "restart",
  "root",
  "run",
  "sbom",
  "search",
  "set",
  "shrinkwrap",
  "star",
  "stars",
  "start",
  "stop",
  "team",
  "test",
  "token",
  "undeprecate",
  "uninstall",
  "unpublish",
  "unstar",
  "update",
  "version",
  "view",
  "whoami",
] as const;

const frozenNpmAliasesV1: Readonly<Record<string, string>> = {
  add: "install",
  "add-user": "adduser",
  author: "owner",
  c: "config",
  cit: "install-ci-test",
  "clean-install": "ci",
  "clean-install-test": "install-ci-test",
  create: "init",
  ddp: "dedupe",
  "dist-tags": "dist-tag",
  find: "search",
  hlep: "help",
  home: "docs",
  i: "install",
  ic: "ci",
  in: "install",
  info: "view",
  innit: "init",
  ins: "install",
  inst: "install",
  insta: "install",
  instal: "install",
  "install-clean": "ci",
  isnt: "install",
  isnta: "install",
  isntal: "install",
  isntall: "install",
  "isntall-clean": "ci",
  issues: "bugs",
  it: "install-test",
  la: "ll",
  list: "ls",
  ln: "link",
  ogr: "org",
  r: "uninstall",
  rb: "rebuild",
  remove: "uninstall",
  rm: "uninstall",
  rum: "run",
  "run-script": "run",
  s: "search",
  se: "search",
  show: "view",
  sit: "install-ci-test",
  t: "test",
  tst: "test",
  un: "uninstall",
  unlink: "uninstall",
  up: "update",
  upgrade: "update",
  udpate: "update",
  urn: "run",
  v: "view",
  verison: "version",
  why: "explain",
  x: "exec",
};

const frozenNpmMutationCommandsV1 = new Set([
  "ci",
  "dedupe",
  "init",
  "install",
  "install-ci-test",
  "install-test",
  "link",
  "prune",
  "publish",
  "rebuild",
  "uninstall",
  "unpublish",
  "update",
]);

const frozenNpmBooleanOptionsV1 = new Set([
  "--all",
  "--allow-same-version",
  "--audit",
  "--bin-links",
  "--commit-hooks",
  "--description",
  "--dev",
  "--diff-ignore-all-space",
  "--diff-name-only",
  "--diff-no-prefix",
  "--diff-text",
  "--dry-run",
  "--engine-strict",
  "--expect-results",
  "--force",
  "--foreground-scripts",
  "--format-package-lock",
  "--fund",
  "--git-tag-version",
  "--global",
  "--global-style",
  "--if-present",
  "--ignore-scripts",
  "--include-staged",
  "--include-workspace-root",
  "--init-private",
  "--install-links",
  "--json",
  "--legacy-bundling",
  "--legacy-peer-deps",
  "--link",
  "--long",
  "--offline",
  "--omit-lockfile-registry-resolved",
  "--optional",
  "--package-lock",
  "--package-lock-only",
  "--parseable",
  "--prefer-dedupe",
  "--prefer-offline",
  "--prefer-online",
  "--production",
  "--progress",
  "--provenance",
  "--read-only",
  "--rebuild-bundle",
  "--save",
  "--save-bundle",
  "--save-dev",
  "--save-exact",
  "--save-optional",
  "--save-peer",
  "--save-prod",
  "--shrinkwrap",
  "--sign-git-commit",
  "--sign-git-tag",
  "--strict-peer-deps",
  "--strict-ssl",
  "--timing",
  "--unicode",
  "--update-notifier",
  "--usage",
  "--version",
  "--versions",
  "--workspaces",
  "--workspaces-update",
  "--yes",
]);

const frozenNpmValueOptionsV1 = new Set([
  "--_auth",
  "--access",
  "--also",
  "--audit-level",
  "--auth-type",
  "--before",
  "--ca",
  "--cache",
  "--cache-max",
  "--cache-min",
  "--cafile",
  "--call",
  "--cert",
  "--cidr",
  "--cpu",
  "--depth",
  "--diff",
  "--diff-dst-prefix",
  "--diff-src-prefix",
  "--diff-unified",
  "--editor",
  "--expect-result-count",
  "--fetch-retries",
  "--fetch-retry-factor",
  "--fetch-retry-maxtimeout",
  "--fetch-retry-mintimeout",
  "--fetch-timeout",
  "--git",
  "--globalconfig",
  "--heading",
  "--https-proxy",
  "--include",
  "--init-author-email",
  "--init-author-name",
  "--init-author-url",
  "--init-license",
  "--init-module",
  "--init-type",
  "--init-version",
  "--init.author.email",
  "--init.author.name",
  "--init.author.url",
  "--init.license",
  "--init.module",
  "--init.version",
  "--install-strategy",
  "--key",
  "--libc",
  "--local-address",
  "--location",
  "--lockfile-version",
  "--loglevel",
  "--logs-dir",
  "--logs-max",
  "--maxsockets",
  "--message",
  "--node-gyp",
  "--node-options",
  "--noproxy",
  "--omit",
  "--only",
  "--os",
  "--otp",
  "--package",
  "--pack-destination",
  "--prefix",
  "--preid",
  "--provenance-file",
  "--proxy",
  "--registry",
  "--replace-registry-host",
  "--save-prefix",
  "--sbom-format",
  "--sbom-type",
  "--scope",
  "--script-shell",
  "--searchexclude",
  "--searchlimit",
  "--searchopts",
  "--searchstaleness",
  "--shell",
  "--tag",
  "--tag-version-prefix",
  "--umask",
  "--user-agent",
  "--userconfig",
  "--viewer",
  "--which",
  "--workspace",
]);

const frozenNpmMixedOptionsV1 = new Set(["--browser", "--color"]);
const frozenNpmExactStringOptionsV1 = new Set([
  "--call",
  "--diff-dst-prefix",
  "--diff-src-prefix",
  "--editor",
  "--git",
  "--heading",
  "--init-author-email",
  "--init-author-name",
  "--init-license",
  "--init-type",
  "--init.author.email",
  "--init.author.name",
  "--init.license",
  "--message",
  "--pack-destination",
  "--preid",
  "--save-prefix",
  "--scope",
  "--searchexclude",
  "--searchopts",
  "--shell",
  "--tag",
  "--tag-version-prefix",
  "--user-agent",
  "--viewer",
]);
const frozenNpmNullableValueOptionsV1 = new Set([
  "--_auth",
  "--access",
  "--also",
  "--audit-level",
  "--before",
  "--browser",
  "--ca",
  "--cert",
  "--cidr",
  "--cpu",
  "--depth",
  "--expect-result-count",
  "--expect-results",
  "--https-proxy",
  "--key",
  "--libc",
  "--lockfile-version",
  "--logs-dir",
  "--node-options",
  "--only",
  "--optional",
  "--os",
  "--otp",
  "--production",
  "--proxy",
  "--script-shell",
  "--which",
  "--workspaces",
  "--yes",
]);
const frozenNpmArrayStringOptionsV1 = new Set([
  "--_auth",
  "--browser",
  "--ca",
  "--cert",
  "--cidr",
  "--cpu",
  "--diff",
  "--key",
  "--libc",
  "--node-options",
  "--noproxy",
  "--os",
  "--otp",
  "--package",
  "--replace-registry-host",
  "--script-shell",
  "--workspace",
]);
const frozenNpmNumericArrayOptionsV1 = new Set(["--depth", "--expect-result-count", "--which"]);
const frozenNpmExplicitOptionValuesV1: Readonly<Record<string, readonly string[]>> = {
  "--access": ["public", "restricted"],
  "--also": ["dev", "development"],
  "--audit-level": ["critical", "high", "info", "low", "moderate", "none"],
  "--auth-type": ["legacy", "web"],
  "--color": ["always"],
  "--include": ["dev", "optional", "peer", "prod"],
  "--install-strategy": ["hoisted", "linked", "nested", "shallow"],
  "--location": ["global", "project", "user"],
  "--lockfile-version": ["1", "2", "3"],
  "--loglevel": ["error", "http", "info", "notice", "silent", "silly", "verbose", "warn"],
  "--omit": ["dev", "optional", "peer"],
  "--only": ["prod", "production"],
  "--replace-registry-host": ["always", "never", "npmjs"],
  "--sbom-format": ["cyclonedx", "spdx"],
  "--sbom-type": ["application", "framework", "library"],
};
const frozenNpmShorthandsV1 = {
  "?": ["--usage"],
  B: ["--save-bundle"],
  C: ["--prefix"],
  D: ["--save-dev"],
  E: ["--save-exact"],
  H: ["--usage"],
  L: ["--location"],
  O: ["--save-optional"],
  P: ["--save-prod"],
  S: ["--save"],
  a: ["--all"],
  c: ["--call"],
  d: ["--loglevel", "info"],
  dd: ["--loglevel", "verbose"],
  ddd: ["--loglevel", "silly"],
  desc: ["--description"],
  "enjoy-by": ["--before"],
  f: ["--force"],
  g: ["--global"],
  h: ["--usage"],
  help: ["--usage"],
  iwr: ["--include-workspace-root"],
  l: ["--long"],
  local: ["--no-global"],
  m: ["--message"],
  n: ["--no-yes"],
  no: ["--no-yes"],
  p: ["--parseable"],
  porcelain: ["--parseable"],
  q: ["--loglevel", "warn"],
  quiet: ["--loglevel", "warn"],
  readonly: ["--read-only"],
  reg: ["--registry"],
  s: ["--loglevel", "silent"],
  silent: ["--loglevel", "silent"],
  v: ["--version"],
  verbose: ["--loglevel", "verbose"],
  w: ["--workspace"],
  ws: ["--workspaces"],
  y: ["--yes"],
} as const satisfies Readonly<Record<string, readonly string[]>>;
const frozenNpmDefinitionOptionsV1 = new Set([
  ...frozenNpmBooleanOptionsV1,
  ...frozenNpmValueOptionsV1,
  ...frozenNpmMixedOptionsV1,
]);

function hasNpmMutationCommand(argv: readonly string[]): boolean {
  const positionalArguments = frozenNpmPositionalArgumentsV1(argv);
  const command = resolveFrozenNpmCommandV1(positionalArguments[0] as string);
  if (command === undefined) {
    return false;
  }
  if (frozenNpmMutationCommandsV1.has(command)) {
    return true;
  }
  return (
    command === "version" &&
    positionalArguments.slice(1).some((argument) => !argument.startsWith("-"))
  );
}

type FrozenNpmTokenV1 = {
  readonly hadEquals: boolean;
  readonly value: string;
};

function frozenNpmPositionalArgumentsV1(argv: readonly string[]): readonly string[] {
  const tokens: FrozenNpmTokenV1[] = argv.slice(1).map((value) => ({ hadEquals: false, value }));
  const positionalArguments: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    let token = tokens[index] as FrozenNpmTokenV1;
    if (/^-{2,}$/u.test(token.value)) {
      positionalArguments.push(...tokens.slice(index + 1).map(({ value }) => value));
      break;
    }
    if (!token.value.startsWith("-") || token.value === "-") {
      positionalArguments.push(token.value);
      continue;
    }
    const equalsIndex = token.value.indexOf("=");
    if (equalsIndex !== -1) {
      const option = token.value.slice(0, equalsIndex);
      const value = token.value.slice(equalsIndex + 1);
      token = { hadEquals: true, value: option };
      tokens.splice(index, 1, token, { hadEquals: false, value });
    }
    const optionName = token.value.replace(/^-+/u, "");
    const shorthand = resolveFrozenNpmShorthandV1(optionName);
    if (shorthand !== undefined) {
      tokens.splice(index, 1, ...shorthand.map((value) => ({ hadEquals: false, value })));
      index -= 1;
      continue;
    }
    let normalizedName = optionName;
    let negated = false;
    while (normalizedName.toLowerCase().startsWith("no-")) {
      negated = true;
      normalizedName = normalizedName.slice(3);
    }
    const option = resolveFrozenNpmDefinitionOptionV1(normalizedName);
    const next = tokens[index + 1]?.value;
    const isBoolean =
      negated ||
      (option !== undefined &&
        (frozenNpmBooleanOptionsV1.has(option) || frozenNpmMixedOptionsV1.has(option))) ||
      (option === undefined && !token.hadEquals);
    if (isBoolean) {
      if (next !== undefined && frozenNpmBooleanConsumesV1(option, next)) {
        index += 1;
      }
      continue;
    }
    if (option === undefined) {
      if (token.hadEquals && next !== undefined && !/^-{2,}$/u.test(next)) {
        index += 1;
      }
      continue;
    }
    if (frozenNpmExactStringOptionsV1.has(option)) {
      if (next !== undefined && !/^-{1,2}[^-]+/u.test(next) && !/^-{2,}$/u.test(next)) {
        index += 1;
      }
      continue;
    }
    if (next !== undefined && !/^-{2,}$/u.test(next)) {
      index += 1;
    }
  }
  return positionalArguments;
}

function frozenNpmBooleanConsumesV1(option: string | undefined, next: string): boolean {
  if (next === "false" || next === "true") {
    return true;
  }
  if (option === undefined) {
    return false;
  }
  if (next === "null" && frozenNpmNullableValueOptionsV1.has(option)) {
    return true;
  }
  if (frozenNpmExplicitOptionValuesV1[option]?.includes(next) === true) {
    return true;
  }
  if (
    frozenNpmNumericArrayOptionsV1.has(option) &&
    next.length > 0 &&
    !Number.isNaN(Number(next)) &&
    !/^-{2,}[^-]/u.test(next)
  ) {
    return true;
  }
  return frozenNpmArrayStringOptionsV1.has(option) && !/^-[^-]/u.test(next);
}

function resolveFrozenNpmDefinitionOptionV1(argument: string): string | undefined {
  const exact = `--${argument}`;
  if (frozenNpmDefinitionOptionsV1.has(exact)) {
    return exact;
  }
  const matches = [...frozenNpmDefinitionOptionsV1].filter((option) =>
    option.slice(2).startsWith(argument),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function resolveFrozenNpmShorthandV1(argument: string): readonly string[] | undefined {
  if (frozenNpmDefinitionOptionsV1.has(`--${argument}`)) {
    return undefined;
  }
  const exact = frozenNpmShorthandsV1[argument as keyof typeof frozenNpmShorthandsV1];
  if (exact !== undefined) {
    return exact;
  }
  const characters = [...argument];
  const characterShorthands = characters.map(
    (character) => frozenNpmShorthandsV1[character as keyof typeof frozenNpmShorthandsV1],
  );
  if (characterShorthands.every((shorthand) => shorthand !== undefined)) {
    return characterShorthands.flatMap((shorthand) => shorthand as readonly string[]);
  }
  if (resolveFrozenNpmDefinitionOptionV1(argument) !== undefined) {
    return undefined;
  }
  const matches = Object.keys(frozenNpmShorthandsV1).filter((shorthand) =>
    shorthand.startsWith(argument),
  );
  return matches.length === 1
    ? frozenNpmShorthandsV1[matches[0] as keyof typeof frozenNpmShorthandsV1]
    : undefined;
}

function resolveFrozenNpmCommandV1(argument: string): string | undefined {
  const normalized = /[A-Z]/u.test(argument)
    ? argument.replace(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`)
    : argument;
  if ((frozenNpmCommandsV1 as readonly string[]).includes(normalized)) {
    return normalized;
  }
  const directAlias = frozenNpmAliasesV1[normalized];
  if (directAlias !== undefined) {
    return directAlias;
  }
  const matches = [
    ...(frozenNpmCommandsV1 as readonly string[]),
    ...Object.keys(frozenNpmAliasesV1),
  ].filter((candidate) => candidate.startsWith(normalized));
  if (matches.length !== 1) {
    return undefined;
  }
  let resolved = matches[0] as string;
  const seen = new Set<string>();
  while (frozenNpmAliasesV1[resolved] !== undefined && !seen.has(resolved)) {
    seen.add(resolved);
    resolved = frozenNpmAliasesV1[resolved] as string;
  }
  return resolved;
}

function hasPackageMutationSubcommand(command: string, argv: readonly string[]): boolean {
  if (command === "npm") {
    return hasNpmMutationCommand(argv);
  }
  if (command === "yarn" && argv.length === 1) {
    return true;
  }
  const mutationSubcommands = new Set(
    command === "pnpm"
      ? [
          "add",
          "dedupe",
          "deploy",
          "fetch",
          "i",
          "import",
          "install",
          "link",
          "patch",
          "patch-commit",
          "prune",
          "publish",
          "rebuild",
          "remove",
          "rm",
          "unlink",
          "up",
          "update",
        ]
      : command === "yarn"
        ? ["add", "install", "link", "npm", "remove", "set", "unlink", "up", "upgrade"]
        : command === "bun"
          ? [
              "add",
              "i",
              "install",
              "link",
              "patch",
              "patch-commit",
              "publish",
              "remove",
              "rm",
              "unlink",
              "update",
            ]
          : [
              "add",
              "install",
              "login",
              "owner",
              "publish",
              "remove",
              "uninstall",
              "update",
              "yank",
            ],
  );
  const valueOptions = [
    "--cache",
    "--color",
    "--config",
    "--dir",
    "--filter",
    "--globalconfig",
    "--jobs",
    "--location",
    "--loglevel",
    "--prefix",
    "--registry",
    "--scope",
    "--tag",
    "--userconfig",
    "--workspace",
    "-C",
  ];
  const flagOptions = [
    "--audit",
    "--force",
    "--fund",
    "--global",
    "--help",
    "--json",
    "--long",
    "--no-audit",
    "--no-fund",
    "--no-unicode",
    "--offline",
    "--parseable",
    "--quiet",
    "--silent",
    "--unicode",
    "--usage",
    "--verbose",
    "--version",
    "--workspace-root",
    ...(command === "pnpm" ? ["-w"] : []),
    ...(command === "cargo" ? ["--frozen", "--locked"] : ["--ignore-scripts"]),
    "-g",
    "-h",
    "-q",
    "-s",
    "-v",
  ];
  const attachedValuePrefixes = valueOptions.map((option) =>
    option.startsWith("--") ? `${option}=` : option,
  );
  let uncertainOptionPosition = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === "--") {
      const subcommand = argv[index + 1];
      return mutationSubcommands.has(subcommand as string);
    }
    if (command === "cargo" && index === 1 && /^\+[A-Za-z0-9._-]+$/u.test(argument)) {
      continue;
    }
    if (valueOptions.includes(argument)) {
      index += 1;
      continue;
    }
    if (
      attachedValuePrefixes.some(
        (prefix) => argument.startsWith(prefix) && argument.length > prefix.length,
      ) ||
      flagOptions.includes(argument)
    ) {
      continue;
    }
    if (argument.startsWith("-") && argument !== "-") {
      uncertainOptionPosition = true;
      continue;
    }
    if (mutationSubcommands.has(argument)) {
      return true;
    }
    if (!uncertainOptionPosition) {
      return false;
    }
  }
  return false;
}

function hasSedInPlaceOption(arguments_: readonly string[]): boolean {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] as string;
    if (argument === "--") {
      return false;
    }
    if (argument.startsWith("--")) {
      const separatorIndex = argument.indexOf("=");
      const option = separatorIndex === -1 ? argument : argument.slice(0, separatorIndex);
      const resolved = resolveSedLongOption(option);
      if (resolved === "--in-place") {
        return true;
      }
      if (
        separatorIndex === -1 &&
        (resolved === "--expression" || resolved === "--file" || resolved === "--line-length")
      ) {
        index += 1;
      }
      continue;
    }
    if (!argument.startsWith("-")) {
      continue;
    }
    for (let optionIndex = 1; optionIndex < argument.length; optionIndex += 1) {
      const option = argument[optionIndex] as string;
      if (option === "i") {
        return true;
      }
      if (option === "e" || option === "f" || option === "l") {
        if (optionIndex + 1 === argument.length) {
          index += 1;
        }
        break;
      }
    }
  }
  return false;
}

function resolveSedLongOption(argument: string): string | undefined {
  const options = [
    "--debug",
    "--expression",
    "--file",
    "--follow-symlinks",
    "--help",
    "--in-place",
    "--line-length",
    "--null-data",
    "--posix",
    "--quiet",
    "--regexp-extended",
    "--sandbox",
    "--separate",
    "--silent",
    "--unbuffered",
    "--version",
  ];
  const matches = options.filter((option) => option.startsWith(argument));
  return matches.length === 1 ? matches[0] : undefined;
}

function hasSortOutputOption(arguments_: readonly string[]): boolean {
  const longValueOptions = [
    "--batch-size",
    "--buffer-size",
    "--compress-program",
    "--field-separator",
    "--files0-from",
    "--key",
    "--parallel",
    "--random-source",
    "--sort",
    "--temporary-directory",
  ];
  const shortValueOptions = new Set(["k", "S", "t", "T"]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] as string;
    if (argument === "--") {
      return false;
    }
    if (argument.startsWith("--")) {
      const separatorIndex = argument.indexOf("=");
      const option = separatorIndex === -1 ? argument : argument.slice(0, separatorIndex);
      const resolved = resolveSortLongOption(option);
      if (resolved === "--output") {
        return true;
      }
      if (separatorIndex === -1 && resolved !== undefined && longValueOptions.includes(resolved)) {
        index += 1;
      }
      continue;
    }
    if (!argument.startsWith("-") || argument === "-") {
      continue;
    }
    for (let optionIndex = 1; optionIndex < argument.length; optionIndex += 1) {
      const option = argument[optionIndex] as string;
      if (option === "o") {
        return true;
      }
      if (shortValueOptions.has(option)) {
        if (optionIndex + 1 === argument.length) {
          index += 1;
        }
        break;
      }
    }
  }
  return false;
}

function resolveSortLongOption(argument: string): string | undefined {
  const options = [
    "--batch-size",
    "--buffer-size",
    "--check",
    "--compress-program",
    "--debug",
    "--dictionary-order",
    "--field-separator",
    "--files0-from",
    "--general-numeric-sort",
    "--help",
    "--human-numeric-sort",
    "--ignore-case",
    "--ignore-leading-blanks",
    "--ignore-nonprinting",
    "--key",
    "--merge",
    "--month-sort",
    "--numeric-sort",
    "--output",
    "--parallel",
    "--random-sort",
    "--random-source",
    "--reverse",
    "--sort",
    "--stable",
    "--temporary-directory",
    "--unique",
    "--version",
    "--version-sort",
    "--zero-terminated",
  ];
  const matches = options.filter((option) => option.startsWith(argument));
  return matches.length === 1 ? matches[0] : undefined;
}

function hasPerlInPlaceOption(arguments_: readonly string[]): boolean {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] as string;
    if (argument === "--") {
      return false;
    }
    if (!argument.startsWith("-") || argument.startsWith("--")) {
      continue;
    }
    for (let optionIndex = 1; optionIndex < argument.length; optionIndex += 1) {
      const option = argument[optionIndex] as string;
      if (option === "i") {
        return true;
      }
      if (["e", "E", "F", "I", "m", "M"].includes(option)) {
        if (optionIndex + 1 === argument.length) {
          index += 1;
        }
        break;
      }
    }
  }
  return false;
}

function commandIndexAfterLeadingOptions(
  argv: readonly string[],
  start: number,
  options: {
    readonly valueOptions: readonly string[];
    readonly attachedValuePrefixes: readonly string[];
    readonly flagOptions?: readonly string[];
  },
): number | undefined {
  let index = start;
  while (index < argv.length) {
    const argument = argv[index] as string;
    if (argument === "--") {
      return index + 1 < argv.length ? index + 1 : undefined;
    }
    if (!argument.startsWith("-") || argument === "-") {
      return index;
    }
    if (options.valueOptions.includes(argument)) {
      index += 2;
      if (index > argv.length) {
        return undefined;
      }
      continue;
    }
    if (
      options.attachedValuePrefixes.some(
        (prefix) => argument.startsWith(prefix) && argument.length > prefix.length,
      ) ||
      options.flagOptions?.includes(argument) === true
    ) {
      index += 1;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function argumentsBeforeOperandSeparator(arguments_: readonly string[]): readonly string[] {
  const separator = arguments_.indexOf("--");
  return separator === -1 ? arguments_ : arguments_.slice(0, separator);
}

function hasFindMutationPredicate(arguments_: readonly string[]): boolean {
  const predicatesWithOneValue = new Set([
    "-amin",
    "-anewer",
    "-atime",
    "-cmin",
    "-cnewer",
    "-ctime",
    "-fstype",
    "-gid",
    "-group",
    "-iname",
    "-inum",
    "-links",
    "-maxdepth",
    "-mindepth",
    "-mmin",
    "-mtime",
    "-name",
    "-newer",
    "-path",
    "-perm",
    "-regex",
    "-regextype",
    "-samefile",
    "-size",
    "-type",
    "-uid",
    "-user",
    "-wholename",
    "-xtype",
  ]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] as string;
    if (["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(argument)) {
      return true;
    }
    if (predicatesWithOneValue.has(argument)) {
      index += 1;
    }
  }
  return false;
}

function isVersionObservation(argv: readonly string[] | undefined): boolean {
  return (
    argv?.length === 2 &&
    argv[1] === "--version" &&
    (argv[0] === "git" || argv[0] === "rg" || argv[0] === "node")
  );
}

function isSystemObservation(argv: readonly string[] | undefined): boolean {
  if (argv === undefined) {
    return false;
  }
  if (argv.length === 1) {
    return (
      argv[0] === "uptime" || argv[0] === "hostname" || argv[0] === "uname" || argv[0] === "date"
    );
  }
  if (argv.length !== 2) {
    return false;
  }
  return (
    (argv[0] === "uname" && ["-a", "-s", "-r", "-m"].includes(argv[1] as string)) ||
    (argv[0] === "id" && ["-u", "-g", "-G"].includes(argv[1] as string)) ||
    (argv[0] === "date" && argv[1] === "-u")
  );
}

function splitCommandSegments(rawCommand: string): readonly string[] | undefined {
  const segments: string[] = [];
  let segment = "";
  let quote: "single" | "double" | undefined;
  let escaped = false;
  const finishSegment = () => {
    const normalized = segment.replace(/^[\t ]+|[\t ]+$/gu, "");
    if (normalized.length === 0) {
      return false;
    }
    segments.push(normalized);
    segment = "";
    return true;
  };
  for (let index = 0; index < rawCommand.length; index += 1) {
    const character = rawCommand[index] as string;
    if (escaped) {
      segment += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "single") {
      segment += character;
      escaped = true;
      continue;
    }
    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? undefined : "single";
      segment += character;
      continue;
    }
    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? undefined : "double";
      segment += character;
      continue;
    }
    if (quote !== undefined) {
      segment += character;
      continue;
    }
    if (character === ";" || character === "|") {
      if (!finishSegment()) {
        return undefined;
      }
      if (character === "|" && rawCommand[index + 1] === "|") {
        index += 1;
      }
      continue;
    }
    if (character === "&") {
      if (rawCommand[index + 1] !== "&" || !finishSegment()) {
        return undefined;
      }
      index += 1;
      continue;
    }
    segment += character;
  }
  if (escaped || quote !== undefined || !finishSegment()) {
    return undefined;
  }
  return segments;
}

function tokenizeSimpleCommand(rawCommand: string): readonly string[] | undefined {
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "single" | "double" | undefined;
  let escaped = false;
  const finishToken = () => {
    if (tokenStarted) {
      tokens.push(token);
      token = "";
      tokenStarted = false;
    }
  };
  for (let index = 0; index < rawCommand.length; index += 1) {
    const character = rawCommand[index] as string;
    if (escaped) {
      token += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (quote === "single") {
      if (character === "'") {
        quote = undefined;
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }
    if (quote === "double") {
      if (character === '"') {
        quote = undefined;
      } else if (character === "\\") {
        const next = rawCommand[index + 1];
        if (next !== undefined && ["$", "`", '"', "\\"].includes(next)) {
          escaped = true;
        } else {
          token += "\\";
        }
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      tokenStarted = true;
    } else if (character === "'") {
      quote = "single";
      tokenStarted = true;
    } else if (character === '"') {
      quote = "double";
      tokenStarted = true;
    } else if (character === " " || character === "\t") {
      finishToken();
    } else {
      token += character;
      tokenStarted = true;
    }
  }
  if (escaped || quote !== undefined) {
    return undefined;
  }
  finishToken();
  return tokens;
}

function assessment(
  rawCommand: string,
  disposition: PlanCommandAssessment["disposition"],
  reasons: PlanCommandAssessment["reasons"],
  status: PlanCommandAssessment["status"] = "assessed",
  executionIdentity?: unknown,
): PlanCommandAssessment {
  const identity = {
    status,
    version: 1 as const,
    policyVersion: "plan-shell-policy.v1" as const,
    rawCommand,
    disposition,
    reasons,
    ...(executionIdentity === undefined ? {} : { executionIdentity }),
  };
  return {
    status: identity.status,
    version: identity.version,
    policyVersion: identity.policyVersion,
    disposition: identity.disposition,
    reasons: identity.reasons,
    digest: `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`,
  };
}
