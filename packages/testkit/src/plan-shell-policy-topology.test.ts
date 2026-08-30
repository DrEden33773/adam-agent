import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agent", "src");
const childProcessLaunchers = new Set(["execFile", "execFileSync", "spawn", "spawnSync"]);
const childProcessModuleSpecifiers = new Set(["child_process", "node:child_process"]);

type StructuralToken = {
  readonly kind: "identifier" | "punctuator" | "string";
  readonly offset: number;
  readonly value: string;
};

function structuralTokens(source: string): readonly StructuralToken[] {
  const tokens: StructuralToken[] = [];
  for (let index = 0; index < source.length; ) {
    const character = source[index] as string;
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (source.startsWith("//", index)) {
      const lineEnd = source.indexOf("\n", index + 2);
      index = lineEnd === -1 ? source.length : lineEnd + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const commentEnd = source.indexOf("*/", index + 2);
      index = commentEnd === -1 ? source.length : commentEnd + 2;
      continue;
    }
    if (/[A-Za-z_$]/u.test(character)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_$]/u.test(source[end] as string)) {
        end += 1;
      }
      tokens.push({ kind: "identifier", offset: index, value: source.slice(index, end) });
      index = end;
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      let end = index + 1;
      let value = "";
      while (end < source.length) {
        const current = source[end] as string;
        if (current === "\\" && end + 1 < source.length) {
          value += source[end + 1] as string;
          end += 2;
          continue;
        }
        if (current === quote) {
          end += 1;
          break;
        }
        value += current;
        end += 1;
      }
      tokens.push({ kind: "string", offset: index, value });
      index = end;
      continue;
    }
    if (character === "`") {
      let end = index + 1;
      let interpolated = false;
      let value = "";
      while (end < source.length) {
        if (source[end] === "\\") {
          value += source[end + 1] as string;
          end += 2;
          continue;
        }
        if (source.startsWith("${", end)) {
          interpolated = true;
        }
        if (source[end] === "`") {
          end += 1;
          break;
        }
        value += source[end] as string;
        end += 1;
      }
      if (!interpolated) {
        tokens.push({ kind: "string", offset: index, value });
      }
      index = end;
      continue;
    }
    tokens.push({ kind: "punctuator", offset: index, value: character });
    index += 1;
  }
  return tokens;
}

function structuralCallArguments(
  tokens: readonly StructuralToken[],
  openIndex: number,
): readonly (readonly StructuralToken[])[] | undefined {
  const arguments_: StructuralToken[][] = [];
  let current: StructuralToken[] = [];
  let bracketDepth = 0;
  let braceDepth = 0;
  let parenthesisDepth = 0;
  for (let index = openIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index] as StructuralToken;
    if (token.value === ")" && parenthesisDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      arguments_.push(current);
      return arguments_;
    }
    if (token.value === "," && parenthesisDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      arguments_.push(current);
      current = [];
      continue;
    }
    current.push(token);
    if (token.value === "(") {
      parenthesisDepth += 1;
    } else if (token.value === ")") {
      parenthesisDepth -= 1;
    } else if (token.value === "[") {
      bracketDepth += 1;
    } else if (token.value === "]") {
      bracketDepth -= 1;
    } else if (token.value === "{") {
      braceDepth += 1;
    } else if (token.value === "}") {
      braceDepth -= 1;
    }
  }
  return undefined;
}

function structuralAssignmentValue(
  tokens: readonly StructuralToken[],
  startIndex: number,
): readonly StructuralToken[] {
  const value: StructuralToken[] = [];
  let bracketDepth = 0;
  let braceDepth = 0;
  let parenthesisDepth = 0;
  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index] as StructuralToken;
    if (
      (token.value === ";" || token.value === ",") &&
      parenthesisDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      break;
    }
    value.push(token);
    if (token.value === "(") {
      parenthesisDepth += 1;
    } else if (token.value === ")") {
      parenthesisDepth -= 1;
    } else if (token.value === "[") {
      bracketDepth += 1;
    } else if (token.value === "]") {
      bracketDepth -= 1;
    } else if (token.value === "{") {
      braceDepth += 1;
    } else if (token.value === "}") {
      braceDepth -= 1;
    }
  }
  return value;
}

function structuralAssignmentIndex(
  tokens: readonly StructuralToken[],
  identifierIndex: number,
): number | undefined {
  if (tokens[identifierIndex + 1]?.value === "=") {
    return identifierIndex + 1;
  }
  if (tokens[identifierIndex + 1]?.value !== ":") {
    return undefined;
  }
  let angleDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let parenthesisDepth = 0;
  for (let index = identifierIndex + 2; index < tokens.length; index += 1) {
    const token = tokens[index] as StructuralToken;
    const atTopLevel =
      angleDepth === 0 && bracketDepth === 0 && braceDepth === 0 && parenthesisDepth === 0;
    if (atTopLevel && (token.value === ";" || token.value === ",")) {
      return undefined;
    }
    if (atTopLevel && token.value === "=" && tokens[index + 1]?.value !== ">") {
      return index;
    }
    if (token.value === "(") {
      parenthesisDepth += 1;
    } else if (token.value === ")") {
      parenthesisDepth -= 1;
    } else if (token.value === "[") {
      bracketDepth += 1;
    } else if (token.value === "]") {
      bracketDepth -= 1;
    } else if (token.value === "{") {
      braceDepth += 1;
    } else if (token.value === "}") {
      braceDepth -= 1;
    } else if (token.value === "<") {
      angleDepth += 1;
    } else if (token.value === ">" && angleDepth > 0) {
      angleDepth -= 1;
    }
  }
  return undefined;
}

function structuralTransparentExpression(
  expression: readonly StructuralToken[],
): readonly StructuralToken[] {
  let transparent = expression;
  let changed = true;
  while (changed && transparent.length > 0) {
    changed = false;
    if (transparent[0]?.value === "(") {
      let depth = 0;
      let matchingClose = -1;
      for (let index = 0; index < transparent.length; index += 1) {
        if (transparent[index]?.value === "(") {
          depth += 1;
        } else if (transparent[index]?.value === ")") {
          depth -= 1;
          if (depth === 0) {
            matchingClose = index;
            break;
          }
        }
      }
      if (matchingClose === transparent.length - 1) {
        transparent = transparent.slice(1, -1);
        changed = true;
        continue;
      }
    }
    let bracketDepth = 0;
    let braceDepth = 0;
    let parenthesisDepth = 0;
    for (let index = 0; index < transparent.length; index += 1) {
      const token = transparent[index] as StructuralToken;
      if (
        (token.value === "as" || token.value === "satisfies") &&
        parenthesisDepth === 0 &&
        bracketDepth === 0 &&
        braceDepth === 0
      ) {
        transparent = transparent.slice(0, index);
        changed = true;
        break;
      }
      if (token.value === "(") {
        parenthesisDepth += 1;
      } else if (token.value === ")") {
        parenthesisDepth -= 1;
      } else if (token.value === "[") {
        bracketDepth += 1;
      } else if (token.value === "]") {
        bracketDepth -= 1;
      } else if (token.value === "{") {
        braceDepth += 1;
      } else if (token.value === "}") {
        braceDepth -= 1;
      }
    }
  }
  return transparent;
}

function structuralArrayElements(
  untrustedExpression: readonly StructuralToken[],
): readonly (readonly StructuralToken[])[] | undefined {
  const transparent = structuralTransparentExpression(untrustedExpression);
  const expression =
    transparent[0]?.value === "." && transparent[1]?.value === "." && transparent[2]?.value === "."
      ? structuralTransparentExpression(transparent.slice(3))
      : transparent;
  if (expression[0]?.value !== "[" || expression.at(-1)?.value !== "]") {
    return undefined;
  }
  const elements: StructuralToken[][] = [[]];
  let bracketDepth = 0;
  let braceDepth = 0;
  let parenthesisDepth = 0;
  for (const token of expression.slice(1, -1)) {
    if (token.value === "," && parenthesisDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      elements.push([]);
      continue;
    }
    elements.at(-1)?.push(token);
    if (token.value === "(") {
      parenthesisDepth += 1;
    } else if (token.value === ")") {
      parenthesisDepth -= 1;
    } else if (token.value === "[") {
      bracketDepth += 1;
    } else if (token.value === "]") {
      bracketDepth -= 1;
    } else if (token.value === "{") {
      braceDepth += 1;
    } else if (token.value === "}") {
      braceDepth -= 1;
    }
  }
  return elements;
}

function structuralExpressionReferences(
  untrustedExpression: readonly StructuralToken[],
  literal: string,
  bindings: ReadonlySet<string>,
): boolean {
  const expression = structuralTransparentExpression(untrustedExpression);
  return (
    expression.length === 1 &&
    ((expression[0]?.kind === "string" && expression[0]?.value === literal) ||
      (expression[0]?.kind === "identifier" && bindings.has(expression[0]?.value as string)))
  );
}

function structuralExpressionReferencesArgv(
  untrustedExpression: readonly StructuralToken[],
  bindings: ReadonlySet<string>,
): boolean {
  const expression = structuralTransparentExpression(untrustedExpression);
  return (
    (expression.length === 1 &&
      expression[0]?.kind === "identifier" &&
      bindings.has(expression[0]?.value)) ||
    (expression[0]?.value === "[" &&
      expression[1]?.kind === "string" &&
      expression[1]?.value === "-c" &&
      expression.at(-1)?.value === "]")
  );
}

function structuralExpressionReferencesBinding(
  untrustedExpression: readonly StructuralToken[],
  bindings: ReadonlySet<string>,
): boolean {
  const transparent = structuralTransparentExpression(untrustedExpression);
  const expression =
    transparent[0]?.value === "." && transparent[1]?.value === "." && transparent[2]?.value === "."
      ? structuralTransparentExpression(transparent.slice(3))
      : transparent;
  return (
    expression.length === 1 &&
    expression[0]?.kind === "identifier" &&
    bindings.has(expression[0]?.value)
  );
}

function planShellExecutorLocations(sources: ReadonlyMap<string, string>): readonly string[] {
  const locations: string[] = [];
  for (const [name, source] of sources) {
    const tokens = structuralTokens(source);
    const launcherBindings = new Set<string>();
    const childProcessNamespaces = new Set<string>();
    const shellBindings = new Set<string>();
    const argvBindings = new Set<string>();
    const packedArgumentBindings = new Set<string>();
    const sourceBridgeLocations = new Set<string>();
    for (let index = 0; index < tokens.length; index += 1) {
      if (
        tokens[index]?.kind === "string" &&
        childProcessModuleSpecifiers.has(tokens[index]?.value as string) &&
        tokens[index - 1]?.value === "("
      ) {
        const offset = tokens[index]?.offset as number;
        const line = source.slice(0, offset).split("\n").length;
        sourceBridgeLocations.add(`${name}:${line}`);
      }
    }
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index]?.value !== "import") {
        continue;
      }
      let fromIndex = -1;
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        if (tokens[cursor]?.value === ";") {
          break;
        }
        if (
          tokens[cursor]?.value === "from" &&
          tokens[cursor + 1]?.kind === "string" &&
          childProcessModuleSpecifiers.has(tokens[cursor + 1]?.value as string)
        ) {
          fromIndex = cursor;
          break;
        }
      }
      if (fromIndex === -1) {
        continue;
      }
      if (tokens[index + 1]?.value === "type") {
        continue;
      }
      const defaultBinding = tokens[index + 1];
      if (defaultBinding?.kind === "identifier") {
        childProcessNamespaces.add(defaultBinding.value);
      }
      for (let bindingIndex = index + 1; bindingIndex < fromIndex; bindingIndex += 1) {
        if (
          tokens[bindingIndex]?.value === "*" &&
          tokens[bindingIndex + 1]?.value === "as" &&
          tokens[bindingIndex + 2]?.kind === "identifier"
        ) {
          childProcessNamespaces.add(tokens[bindingIndex + 2]?.value as string);
          bindingIndex += 2;
          continue;
        }
        if (tokens[bindingIndex]?.value !== "{") {
          continue;
        }
        const close = tokens.findIndex(
          (token, tokenIndex) =>
            tokenIndex > bindingIndex && tokenIndex < fromIndex && token.value === "}",
        );
        if (close === -1) {
          continue;
        }
        for (let namedIndex = bindingIndex + 1; namedIndex < close; namedIndex += 1) {
          const importedName = tokens[namedIndex]?.value;
          if (importedName === undefined || !childProcessLaunchers.has(importedName)) {
            continue;
          }
          const localName =
            tokens[namedIndex + 1]?.value === "as" && tokens[namedIndex + 2]?.kind === "identifier"
              ? tokens[namedIndex + 2]?.value
              : importedName;
          launcherBindings.add(localName as string);
        }
        bindingIndex = close;
      }
    }
    let discoveredBinding = true;
    while (discoveredBinding) {
      discoveredBinding = false;
      for (let index = 0; index < tokens.length; index += 1) {
        const localName = tokens[index];
        if (localName?.kind === "identifier" && tokens[index + 1]?.value === "=") {
          const sourceName = tokens[index + 2];
          if (sourceName?.kind === "identifier" && childProcessNamespaces.has(sourceName.value)) {
            if (
              tokens[index + 3]?.value === "." &&
              childProcessLaunchers.has(tokens[index + 4]?.value as string)
            ) {
              const previousSize = launcherBindings.size;
              launcherBindings.add(localName.value);
              discoveredBinding ||= launcherBindings.size !== previousSize;
              continue;
            }
            if (
              tokens[index + 3]?.value === "[" &&
              tokens[index + 4]?.kind === "string" &&
              childProcessLaunchers.has(tokens[index + 4]?.value as string) &&
              tokens[index + 5]?.value === "]"
            ) {
              const previousSize = launcherBindings.size;
              launcherBindings.add(localName.value);
              discoveredBinding ||= launcherBindings.size !== previousSize;
              continue;
            }
            const previousSize = childProcessNamespaces.size;
            childProcessNamespaces.add(localName.value);
            discoveredBinding ||= childProcessNamespaces.size !== previousSize;
            continue;
          }
          if (sourceName?.kind === "identifier" && launcherBindings.has(sourceName.value)) {
            const previousSize = launcherBindings.size;
            launcherBindings.add(localName.value);
            discoveredBinding ||= launcherBindings.size !== previousSize;
          }
        }
        if (tokens[index]?.value !== "{") {
          continue;
        }
        const close = tokens.findIndex(
          (token, tokenIndex) => tokenIndex > index && token.value === "}",
        );
        if (
          close === -1 ||
          tokens[close + 1]?.value !== "=" ||
          tokens[close + 2]?.kind !== "identifier" ||
          !childProcessNamespaces.has(tokens[close + 2]?.value as string)
        ) {
          continue;
        }
        for (let bindingIndex = index + 1; bindingIndex < close; bindingIndex += 1) {
          const importedName = tokens[bindingIndex];
          if (
            importedName?.kind !== "identifier" ||
            !childProcessLaunchers.has(importedName.value)
          ) {
            continue;
          }
          const reboundName =
            tokens[bindingIndex + 1]?.value === ":" &&
            tokens[bindingIndex + 2]?.kind === "identifier"
              ? tokens[bindingIndex + 2]?.value
              : importedName.value;
          const previousSize = launcherBindings.size;
          launcherBindings.add(reboundName as string);
          discoveredBinding ||= launcherBindings.size !== previousSize;
        }
        index = close;
      }
    }
    let discoveredArgumentBinding = true;
    while (discoveredArgumentBinding) {
      discoveredArgumentBinding = false;
      for (let index = 0; index < tokens.length; index += 1) {
        const localName = tokens[index];
        if (localName?.kind !== "identifier") {
          continue;
        }
        const assignmentIndex = structuralAssignmentIndex(tokens, index);
        if (assignmentIndex === undefined) {
          continue;
        }
        const expression = structuralAssignmentValue(tokens, assignmentIndex + 1);
        if (structuralExpressionReferences(expression, "/bin/sh", shellBindings)) {
          const previousSize = shellBindings.size;
          shellBindings.add(localName.value);
          discoveredArgumentBinding ||= shellBindings.size !== previousSize;
        }
        if (structuralExpressionReferencesArgv(expression, argvBindings)) {
          const previousSize = argvBindings.size;
          argvBindings.add(localName.value);
          discoveredArgumentBinding ||= argvBindings.size !== previousSize;
        }
        const packedArguments = structuralArrayElements(expression);
        if (
          (packedArguments !== undefined &&
            structuralExpressionReferences(packedArguments[0] ?? [], "/bin/sh", shellBindings) &&
            structuralExpressionReferencesArgv(packedArguments[1] ?? [], argvBindings)) ||
          structuralExpressionReferencesBinding(expression, packedArgumentBindings)
        ) {
          const previousSize = packedArgumentBindings.size;
          packedArgumentBindings.add(localName.value);
          discoveredArgumentBinding ||= packedArgumentBindings.size !== previousSize;
        }
      }
    }
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index]?.value !== "export") {
        continue;
      }
      let statementEnd = tokens.length;
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        if (tokens[cursor]?.value === ";") {
          statementEnd = cursor;
          break;
        }
      }
      if (tokens[index + 1]?.value === "type") {
        index = statementEnd;
        continue;
      }
      let directChildProcessReexport = tokens
        .slice(index + 1, statementEnd)
        .some((token) => token.kind === "string" && childProcessModuleSpecifiers.has(token.value));
      if (directChildProcessReexport && tokens[index + 1]?.value === "{") {
        const close = tokens.findIndex(
          (token, tokenIndex) =>
            tokenIndex > index + 1 && tokenIndex < statementEnd && token.value === "}",
        );
        if (close !== -1) {
          const exportedEntries: StructuralToken[][] = [[]];
          for (const token of tokens.slice(index + 2, close)) {
            if (token.value === ",") {
              exportedEntries.push([]);
            } else {
              exportedEntries.at(-1)?.push(token);
            }
          }
          directChildProcessReexport = exportedEntries.some(
            (entry) => entry.length > 0 && entry[0]?.value !== "type",
          );
        }
      }
      const boundChildProcessReexport = tokens
        .slice(index + 1, statementEnd)
        .some(
          (token) =>
            token.kind === "identifier" &&
            (launcherBindings.has(token.value) || childProcessNamespaces.has(token.value)),
        );
      if (directChildProcessReexport || boundChildProcessReexport) {
        const offset = tokens[index]?.offset as number;
        const line = source.slice(0, offset).split("\n").length;
        sourceBridgeLocations.add(`${name}:${line}`);
      }
      index = statementEnd;
    }
    locations.push(...sourceBridgeLocations);
    for (let openIndex = 0; openIndex < tokens.length; openIndex += 1) {
      if (tokens[openIndex]?.value !== "(") {
        continue;
      }
      const arguments_ = structuralCallArguments(tokens, openIndex);
      if (arguments_ === undefined) {
        continue;
      }
      const memberInvocation = tokens[openIndex - 2]?.value === ".";
      const memberName = memberInvocation ? tokens[openIndex - 1]?.value : undefined;
      const shiftedInvocation = memberName === "call" || memberName === "bind";
      const candidatePairs: Array<
        readonly [readonly StructuralToken[], readonly StructuralToken[]]
      > = [
        [arguments_[shiftedInvocation ? 1 : 0] ?? [], arguments_[shiftedInvocation ? 2 : 1] ?? []],
      ];
      for (const argument of arguments_) {
        const packedArguments = structuralArrayElements(argument);
        if (packedArguments !== undefined) {
          candidatePairs.push([packedArguments[0] ?? [], packedArguments[1] ?? []]);
        }
      }
      const exactPlanShellPair = candidatePairs.some(
        ([shellArgument, argvArgument]) =>
          structuralExpressionReferences(shellArgument, "/bin/sh", shellBindings) &&
          structuralExpressionReferencesArgv(argvArgument, argvBindings),
      );
      const exactPackedPlanShellPair = arguments_.some((argument) =>
        structuralExpressionReferencesBinding(argument, packedArgumentBindings),
      );
      if (!exactPlanShellPair && !exactPackedPlanShellPair) {
        continue;
      }
      const offset = tokens[openIndex - 1]?.offset ?? tokens[openIndex]?.offset ?? 0;
      const line = source.slice(0, offset).split("\n").length;
      const location = `${name}:${line}`;
      if (!sourceBridgeLocations.has(location)) {
        locations.push(location);
      }
    }
  }
  return locations;
}

async function readTypeScriptSources(
  directory: string,
  prefix = "",
): Promise<ReadonlyMap<string, string>> {
  const sources = new Map<string, string>();
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const entry of entries) {
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [name, source] of await readTypeScriptSources(
        join(directory, entry.name),
        relativePath,
      )) {
        sources.set(name, source);
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      sources.set(relativePath, await readFile(join(directory, entry.name), "utf8"));
    }
  }
  return sources;
}

test("Plan shell executor detector follows every child-process launcher binding", () => {
  const fixtureSources = new Map([
    ["direct.ts", 'import { spawn } from "node:child_process"; spawn("/bin/sh", ["-c", command]);'],
    [
      "alias.ts",
      'import { execFile as run } from "node:child_process"; run /* bound alias */ ("/bin/sh", ["-c", raw]);',
    ],
    [
      "namespace.ts",
      'import * as childProcess from "node:child_process"; childProcess.spawnSync("/bin/sh", ["-c", value]);',
    ],
    [
      "default-dot.ts",
      'import childProcess from "node:child_process"; childProcess.spawn("/bin/sh", ["-c", value]);',
    ],
    [
      "default-bracket.ts",
      'import childProcess from "node:child_process"; childProcess["execFileSync"]("/bin/sh", ["-c", value]);',
    ],
    [
      "default-named.ts",
      'import childProcess, { spawnSync as run } from "node:child_process"; childProcess.spawn("/bin/sh", ["-c", value]); run("/bin/sh", ["-c", raw]);',
    ],
    [
      "default-namespace.ts",
      'import childProcess, * as child from "node:child_process"; childProcess.execFile("/bin/sh", ["-c", value]); child.spawn("/bin/sh", ["-c", raw]);',
    ],
    [
      "rebinding.ts",
      'import childProcess from "node:child_process"; const child = childProcess; const { spawn: run, execFileSync } = child; const sync = childProcess.spawnSync; const file = child["execFile"]; run("/bin/sh", ["-c", raw]); execFileSync("/bin/sh", ["-c", value]); sync("/bin/sh", ["-c", command]); file("/bin/sh", ["-c", command]);',
    ],
    ["bridge.ts", 'export { spawn as run } from "node:child_process";'],
    ["bare-module.ts", 'import { spawn } from "child_process"; spawn("/bin/sh", ["-c", raw]);'],
    ["bare-reexport.ts", 'export * from "child_process";'],
    [
      "dynamic-import.ts",
      'const { spawn: run } = await import("node:child_process"); run("/bin/sh", ["-c", raw]);',
    ],
    [
      "dynamic-template.ts",
      'const child = await import(`child_process`); child.spawn("/bin/sh", ["-c", raw]);',
    ],
    [
      "create-require.ts",
      'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); const { spawn } = load("child_process"); spawn("/bin/sh", ["-c", raw]);',
    ],
    [
      "dynamic-options.ts",
      'const child = await import("node:child_process", {}); child.spawn("/bin/sh", ["-c", raw]);',
    ],
    [
      "require-options.ts",
      'const child = require("child_process", {}); child.spawn("/bin/sh", ["-c", raw]);',
    ],
    [
      "dynamic-trailing-comma.ts",
      'const child = await import("node:child_process",); child.spawn("/bin/sh", ["-c", raw]);',
    ],
    ["origin-independent.ts", 'function launch() {} launch("/bin/sh", ["-c", raw]);'],
    [
      "two-on-line.ts",
      'function launch() {} launch("/bin/sh", ["-c", first]); launch("/bin/sh", ["-c", second]);',
    ],
    ["transparent-shell.ts", 'function launch() {} launch(("/bin/sh"), ["-c", raw]);'],
    ["transparent-argv.ts", 'function launch() {} launch("/bin/sh", (["-c", raw] as const));'],
    [
      "constant-shell.ts",
      'import { spawn } from "node:child_process"; const shell = "/bin/sh"; spawn(shell, ["-c", raw]);',
    ],
    ["constant-argv.ts", 'function launch() {} const argv = ["-c", raw]; launch("/bin/sh", argv);'],
    [
      "typed-shell.ts",
      'import { spawn } from "node:child_process"; const shell: string = "/bin/sh"; spawn(shell, ["-c", raw]);',
    ],
    [
      "typed-argv.ts",
      'function launch() {} const argv: readonly string[] = ["-c", raw]; launch("/bin/sh", argv);',
    ],
    [
      "call.ts",
      'import { spawn } from "node:child_process"; spawn.call(undefined, "/bin/sh", ["-c", raw]);',
    ],
    [
      "apply.ts",
      'import { spawn } from "node:child_process"; spawn.apply(undefined, ["/bin/sh", ["-c", raw]]);',
    ],
    [
      "packed-apply.ts",
      'import { spawn } from "node:child_process"; const args = ["/bin/sh", ["-c", raw]]; spawn.apply(undefined, args);',
    ],
    [
      "reflect-apply.ts",
      'import { spawn } from "node:child_process"; Reflect.apply(spawn, undefined, ["/bin/sh", ["-c", raw]]);',
    ],
    [
      "literal-spread.ts",
      'import { spawn } from "node:child_process"; spawn(...["/bin/sh", ["-c", raw]]);',
    ],
    [
      "aliased-spread.ts",
      'import { spawn } from "node:child_process"; const args: Parameters<typeof spawn> = ["/bin/sh", ["-c", raw]]; const aliased = args; spawn(...aliased);',
    ],
    [
      "bind.ts",
      'import { spawn } from "node:child_process"; spawn.bind(undefined, "/bin/sh", ["-c", raw])();',
    ],
    ["type-reexport.ts", 'export type { ChildProcess } from "node:child_process";'],
    ["named-type-reexport.ts", 'export { type ChildProcess } from "node:child_process";'],
    [
      "imported-reexport.ts",
      'import { execFile as run } from "node:child_process"; export { run };',
    ],
    [
      "decoys.ts",
      'import { spawn as run } from "node:child_process"; function spawn() {} spawn("/bin/bash", ["-c", value]); run("/bin/bash", ["-c", value]); run("/bin/sh", ["-lc", value]);',
    ],
  ]);

  expect(
    planShellExecutorLocations(fixtureSources).map((location) => location.split(":")[0]),
  ).toEqual([
    "direct.ts",
    "alias.ts",
    "namespace.ts",
    "default-dot.ts",
    "default-bracket.ts",
    "default-named.ts",
    "default-named.ts",
    "default-namespace.ts",
    "default-namespace.ts",
    "rebinding.ts",
    "rebinding.ts",
    "rebinding.ts",
    "rebinding.ts",
    "bridge.ts",
    "bare-module.ts",
    "bare-reexport.ts",
    "dynamic-import.ts",
    "dynamic-template.ts",
    "create-require.ts",
    "dynamic-options.ts",
    "require-options.ts",
    "dynamic-trailing-comma.ts",
    "origin-independent.ts",
    "two-on-line.ts",
    "two-on-line.ts",
    "transparent-shell.ts",
    "transparent-argv.ts",
    "constant-shell.ts",
    "constant-argv.ts",
    "typed-shell.ts",
    "typed-argv.ts",
    "call.ts",
    "apply.ts",
    "packed-apply.ts",
    "reflect-apply.ts",
    "literal-spread.ts",
    "aliased-spread.ts",
    "bind.ts",
    "imported-reexport.ts",
  ]);
});

test("Plan shell policy has one executor, exact provenance, and no configurable safe bypass", async () => {
  const sources = await readTypeScriptSources(sourceRoot);
  const sourceNames = [...sources.keys()];
  const assessment = sources.get("plan-command-assessment.ts") ?? "";
  const runtime = sources.get("tool-runtime.ts") ?? "";
  const planModules = sourceNames
    .filter((name) => name.split("/").at(-1)?.startsWith("plan-") === true)
    .map((name) => sources.get(name) ?? "")
    .join("\n");
  expect(assessment).toContain("@narumitw/pi-plan-mode@0.56.0");
  expect(assessment).toContain("gitHead 9b4cab310013a71d7990e7736452c3c1aebfd148");
  expect(planModules).not.toMatch(/\bspawn\s*\(/u);
  expect(planModules).not.toMatch(
    /safe(?:Command|Prefix|Suffix|Regex)|trustedCommand|allowCommandCallback/iu,
  );
  expect(planShellExecutorLocations(sources)).toEqual([
    expect.stringMatching(/^tool-runtime\.ts:\d+$/u),
  ]);
  expect(runtime).not.toContain('spawn("/bin/sh", ["-c", normalized');
});
