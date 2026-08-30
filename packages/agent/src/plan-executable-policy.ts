import { createHash } from "node:crypto";
import { lstat, opendir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  assessPlanCommandV1,
  bindPlanCommandExecutionIdentityV1,
  downgradePlanCommandAssessmentV1,
  isPlanAutomaticGitCommandV1,
  isPlanAutomaticRepositoryGitCommandV1,
  type PlanCommandAssessment,
  planAutomaticPathOperandsV1,
  planCommandArgumentsV1,
} from "./plan-command-assessment.js";
import {
  isPlanGitAttestationV1Valid,
  type PlanGitAttestationV1,
  planGitAutomaticPolicyV1,
  planGitEnvironmentV1,
} from "./plan-git-policy.js";
import {
  isPlanShellEnvironmentV1Valid,
  type PlanShellEnvironmentV1,
  type PlanShellFileIdentityV1,
  readPlanShellFileIdentityV1,
} from "./plan-shell-environment.js";

type PlanExecutableProofV1 = {
  readonly environmentDigest: `sha256:${string}`;
  readonly shell: PlanShellFileIdentityV1;
  readonly executables: readonly PlanShellFileIdentityV1[];
  readonly paths: readonly PlanPathProofV1[];
  readonly git?: {
    readonly environmentDigest: `sha256:${string}`;
    readonly policyVersion: "git-auto-policy.v1";
    readonly policyDigest: `sha256:${string}`;
    readonly repository?: PlanGitRepositoryProofV1;
  };
};

type PlanPathProofV1 = {
  readonly operand: string;
  readonly canonicalPath: string;
  readonly components: readonly {
    readonly path: string;
    readonly device: string;
    readonly inode: string;
    readonly mode: number;
    readonly size: number;
    readonly modifiedMilliseconds: number;
  }[];
};

type PlanGitRepositoryProofV1 = {
  readonly gitDirectory: string;
  readonly configDigest: `sha256:${string}`;
  readonly entries: readonly {
    readonly path: string;
    readonly device: string;
    readonly inode: string;
    readonly mode: number;
    readonly size: number;
    readonly modifiedMilliseconds: number;
  }[];
};

export async function assessPlanCommandExecutionV1(input: {
  readonly rawCommand: string;
  readonly shellEnvironment: PlanShellEnvironmentV1;
  readonly workspaceRoot: string;
  readonly gitAttestation?: PlanGitAttestationV1;
}): Promise<PlanCommandAssessment> {
  const parsed = assessPlanCommandV1(input.rawCommand);
  if (parsed.status === "invalid" || parsed.disposition === "deny_mutation") {
    return parsed;
  }
  const shell = await verifiedShell(input.shellEnvironment, input.workspaceRoot);
  if (shell === undefined || hasUnsafePathEntry(input.shellEnvironment, input.workspaceRoot)) {
    return downgradePlanCommandAssessmentV1(input.rawCommand, "environment_untrusted");
  }
  if (parsed.disposition !== "allow_inspection") {
    return bindPlanCommandExecutionIdentityV1(input.rawCommand, parsed, {
      environmentDigest: input.shellEnvironment.digest,
      shell,
    });
  }
  const argumentsBySegment = planCommandArgumentsV1(input.rawCommand);
  if (argumentsBySegment === undefined) {
    return downgradePlanCommandAssessmentV1(input.rawCommand, "executable_untrusted");
  }
  const executables: PlanShellFileIdentityV1[] = [];
  for (const argv of argumentsBySegment) {
    const executable = await resolveTrustedExecutable(
      argv[0],
      input.shellEnvironment,
      input.workspaceRoot,
    );
    if (executable === undefined) {
      return downgradePlanCommandAssessmentV1(input.rawCommand, "executable_untrusted", {
        environmentDigest: input.shellEnvironment.digest,
        shell,
      });
    }
    executables.push(executable);
  }
  const automaticGitArguments = argumentsBySegment.filter((argv) =>
    isPlanAutomaticGitCommandV1(argv),
  );
  let gitProof: PlanExecutableProofV1["git"];
  if (automaticGitArguments.length > 0) {
    gitProof = {
      environmentDigest: planGitEnvironmentV1.digest,
      policyVersion: planGitAutomaticPolicyV1.version,
      policyDigest: planGitAutomaticPolicyV1.digest,
    };
    if (automaticGitArguments.some((argv) => isPlanAutomaticRepositoryGitCommandV1(argv))) {
      const gitExecutable = executables.find((identity) => identity.lookupPath.endsWith("/git"));
      if (
        input.gitAttestation === undefined ||
        gitExecutable === undefined ||
        !isPlanGitAttestationV1Valid(input.gitAttestation) ||
        input.gitAttestation.shellEnvironmentDigest !== input.shellEnvironment.digest ||
        input.gitAttestation.gitPolicyVersion !== planGitAutomaticPolicyV1.version ||
        input.gitAttestation.gitPolicyDigest !== planGitAutomaticPolicyV1.digest ||
        !isDeepStrictEqual(input.gitAttestation.executable, gitExecutable)
      ) {
        return downgradePlanCommandAssessmentV1(input.rawCommand, "git_attestation_required", {
          environmentDigest: input.shellEnvironment.digest,
          shell,
          executables,
          gitEnvironmentDigest: planGitEnvironmentV1.digest,
        });
      }
      const repository = await verifyGitRepository(input.workspaceRoot);
      if (repository === undefined) {
        return downgradePlanCommandAssessmentV1(input.rawCommand, "git_repository_untrusted", {
          environmentDigest: input.shellEnvironment.digest,
          shell,
          executables,
          gitEnvironmentDigest: planGitEnvironmentV1.digest,
        });
      }
      gitProof = { ...gitProof, repository };
    }
  }
  const pathOperands = planAutomaticPathOperandsV1(input.rawCommand);
  if (pathOperands === undefined) {
    return downgradePlanCommandAssessmentV1(input.rawCommand, "path_untrusted");
  }
  const paths: PlanPathProofV1[] = [];
  for (const operand of pathOperands) {
    const proof = await verifyWorkspacePath(operand, input.workspaceRoot);
    if (proof === undefined) {
      return downgradePlanCommandAssessmentV1(input.rawCommand, "path_untrusted", {
        environmentDigest: input.shellEnvironment.digest,
        shell,
        executables,
      });
    }
    paths.push(proof);
  }
  const proof: PlanExecutableProofV1 = {
    environmentDigest: input.shellEnvironment.digest,
    shell,
    executables,
    paths,
    ...(gitProof === undefined ? {} : { git: gitProof }),
  };
  return bindPlanCommandExecutionIdentityV1(input.rawCommand, parsed, proof);
}

async function verifyWorkspacePath(
  operand: string,
  workspaceRoot: string,
): Promise<PlanPathProofV1 | undefined> {
  if (Buffer.byteLength(operand, "utf8") > 4_096 || operand.includes("\0")) {
    return undefined;
  }
  const canonicalWorkspace = await realpath(workspaceRoot);
  let candidate: string;
  if (isAbsolute(operand)) {
    candidate = normalize(operand);
    if (candidate !== operand || !isInside(canonicalWorkspace, candidate)) {
      return undefined;
    }
  } else if (operand === ".") {
    candidate = canonicalWorkspace;
  } else {
    if (
      operand.length === 0 ||
      normalize(operand) !== operand ||
      operand
        .split(sep)
        .some((component) => component === "" || component === "." || component === "..")
    ) {
      return undefined;
    }
    candidate = resolve(canonicalWorkspace, operand);
    if (!isInside(canonicalWorkspace, candidate)) {
      return undefined;
    }
  }
  const relativePath = relative(canonicalWorkspace, candidate);
  const componentPaths = [canonicalWorkspace];
  let current = canonicalWorkspace;
  for (const component of relativePath.split(sep).filter((entry) => entry.length > 0)) {
    current = join(current, component);
    componentPaths.push(current);
  }
  try {
    const components = [];
    for (const path of componentPaths) {
      const metadata = await lstat(path, { bigint: true });
      if (metadata.isSymbolicLink()) {
        return undefined;
      }
      components.push({
        path,
        device: metadata.dev.toString(10),
        inode: metadata.ino.toString(10),
        mode: Number(metadata.mode),
        size: Number(metadata.size),
        modifiedMilliseconds: Number(metadata.mtimeMs),
      });
    }
    const canonicalPath = await realpath(candidate);
    return canonicalPath === candidate && isInside(canonicalWorkspace, canonicalPath)
      ? { operand, canonicalPath, components }
      : undefined;
  } catch {
    return undefined;
  }
}

export async function isPlanCommandExecutionIdentityCurrentV1(input: {
  readonly rawCommand: string;
  readonly assessment: PlanCommandAssessment;
  readonly shellEnvironment: PlanShellEnvironmentV1;
  readonly workspaceRoot: string;
  readonly gitAttestation?: PlanGitAttestationV1;
}): Promise<boolean> {
  const current = await assessPlanCommandExecutionV1(input);
  return current.status === "assessed" && current.digest === input.assessment.digest;
}

export async function resolvePlanTrustedExecutableV1(input: {
  readonly commandName: string;
  readonly shellEnvironment: PlanShellEnvironmentV1;
  readonly workspaceRoot: string;
}): Promise<PlanShellFileIdentityV1 | undefined> {
  return resolveTrustedExecutable(input.commandName, input.shellEnvironment, input.workspaceRoot);
}

async function verifyGitRepository(
  workspaceRoot: string,
): Promise<PlanGitRepositoryProofV1 | undefined> {
  const maximumEntries = 4_096;
  try {
    const canonicalWorkspace = await realpath(workspaceRoot);
    const gitDirectory = join(canonicalWorkspace, ".git");
    const gitMetadata = await lstat(gitDirectory);
    if (!gitMetadata.isDirectory() || gitMetadata.isSymbolicLink()) {
      return undefined;
    }
    const canonicalGitDirectory = await realpath(gitDirectory);
    if (
      canonicalGitDirectory !== gitDirectory ||
      !isInside(canonicalWorkspace, canonicalGitDirectory)
    ) {
      return undefined;
    }
    const objectsDirectory = join(gitDirectory, "objects");
    const objectsMetadata = await lstat(objectsDirectory);
    if (
      !objectsMetadata.isDirectory() ||
      objectsMetadata.isSymbolicLink() ||
      (await realpath(objectsDirectory)) !== objectsDirectory
    ) {
      return undefined;
    }
    for (const forbidden of [
      "commondir",
      "config.worktree",
      "objects/info/alternates",
      "objects/info/http-alternates",
    ]) {
      if (await pathExists(join(gitDirectory, forbidden))) {
        return undefined;
      }
    }
    const packDirectory = join(objectsDirectory, "pack");
    if (await pathExists(packDirectory)) {
      const packMetadata = await lstat(packDirectory);
      if (
        !packMetadata.isDirectory() ||
        packMetadata.isSymbolicLink() ||
        (await realpath(packDirectory)) !== packDirectory
      ) {
        return undefined;
      }
      let packEntries = 0;
      for await (const entry of await opendir(packDirectory)) {
        packEntries += 1;
        if (packEntries > maximumEntries || entry.name.endsWith(".promisor")) {
          return undefined;
        }
      }
    }
    const configBytes = await readFile(join(gitDirectory, "config"));
    if (configBytes.byteLength > 256 * 1024) {
      return undefined;
    }
    const config = new TextDecoder("utf-8", { fatal: true }).decode(configBytes);
    const inertConfig = parseInertGitConfig(config);
    if (inertConfig === undefined) {
      return undefined;
    }
    if (inertConfig.hooksPath !== undefined) {
      const hooksProof = await verifyWorkspacePath(inertConfig.hooksPath, canonicalWorkspace);
      if (hooksProof === undefined || !(await stat(hooksProof.canonicalPath)).isDirectory()) {
        return undefined;
      }
    }
    const entries = [];
    const pending = [gitDirectory];
    while (pending.length > 0) {
      const path = pending.pop() as string;
      const metadata = await lstat(path, { bigint: true });
      if (metadata.isSymbolicLink()) {
        return undefined;
      }
      entries.push({
        path: relative(canonicalWorkspace, path),
        device: metadata.dev.toString(10),
        inode: metadata.ino.toString(10),
        mode: Number(metadata.mode),
        size: Number(metadata.size),
        modifiedMilliseconds: Number(metadata.mtimeMs),
      });
      if (entries.length > maximumEntries) {
        return undefined;
      }
      if (metadata.isDirectory()) {
        const children: string[] = [];
        for await (const child of await opendir(path)) {
          if (entries.length + pending.length + children.length >= maximumEntries) {
            return undefined;
          }
          children.push(child.name);
        }
        children.sort().reverse();
        for (const child of children) {
          pending.push(join(path, child));
        }
      }
    }
    return {
      gitDirectory,
      configDigest: `sha256:${createHash("sha256").update(configBytes).digest("hex")}`,
      entries,
    };
  } catch {
    return undefined;
  }
}

function parseInertGitConfig(config: string): { readonly hooksPath?: string } | undefined {
  let section = "";
  const singletonKeys = new Set<string>();
  let entries = 0;
  let hooksPath: string | undefined;
  for (const rawLine of config.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const sectionMatch = /^\[([A-Za-z0-9.-]+)(?:\s+"([A-Za-z0-9._/-]+)")?\]$/u.exec(line);
    if (sectionMatch !== null) {
      const sectionName = sectionMatch[1];
      if (sectionName === undefined) {
        return undefined;
      }
      section = (
        sectionMatch[2] === undefined ? sectionName : `${sectionName}.${sectionMatch[2]}`
      ).toLowerCase();
      continue;
    }
    const separator = line.indexOf("=");
    if (section.length === 0 || separator <= 0) {
      return undefined;
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    const key = `${section}.${name}`;
    entries += 1;
    if (
      entries > 4_096 ||
      Buffer.byteLength(key, "utf8") > 4_096 ||
      Buffer.byteLength(value, "utf8") > 4_096
    ) {
      return undefined;
    }
    if (
      key.startsWith("include.") ||
      key.startsWith("includeif.") ||
      /["\\#;]/u.test(value) ||
      [...value].some((character) => {
        const code = character.codePointAt(0) as number;
        return code < 0x20 || code === 0x7f;
      })
    ) {
      return undefined;
    }
    const singleton = !/^remote\.[^.]+\.fetch$/u.test(key);
    if ((singleton && singletonKeys.has(key)) || !isAllowedGitConfigEntry(key, value)) {
      return undefined;
    }
    if (singleton) {
      singletonKeys.add(key);
    }
    if (key === "core.hookspath") {
      hooksPath = value;
    }
  }
  if (!singletonKeys.has("core.repositoryformatversion") || !singletonKeys.has("core.bare")) {
    return undefined;
  }
  return hooksPath === undefined ? {} : { hooksPath };
}

function isAllowedGitConfigEntry(key: string, value: string): boolean {
  if (key === "core.repositoryformatversion") {
    return value === "0";
  }
  if (key === "core.bare") {
    return value.toLowerCase() === "false";
  }
  if (
    [
      "core.filemode",
      "core.logallrefupdates",
      "core.ignorecase",
      "core.precomposeunicode",
    ].includes(key)
  ) {
    return /^(?:true|false)$/iu.test(value);
  }
  if (key === "core.hookspath") {
    return value.length > 0 && normalize(value) === value && !value.split(/[\\/]/u).includes("..");
  }
  return (
    key === "user.name" ||
    key === "user.email" ||
    /^remote\.[^.]+\.(?:url|fetch)$/u.test(key) ||
    /^branch\.[^.]+\.(?:remote|merge)$/u.test(key) ||
    /^submodule\.[^.]+\.(?:url|active)$/u.test(key)
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}

async function verifiedShell(
  environment: PlanShellEnvironmentV1,
  workspaceRoot: string,
): Promise<PlanShellFileIdentityV1 | undefined> {
  if (!isPlanShellEnvironmentV1Valid(environment)) {
    return undefined;
  }
  if ("status" in environment.shell) {
    return undefined;
  }
  try {
    const current = await readPlanShellFileIdentityV1(environment.shell.lookupPath);
    return isDeepStrictEqual(current, environment.shell) &&
      (await isTrustedSystemExecutable(current, workspaceRoot))
      ? current
      : undefined;
  } catch {
    return undefined;
  }
}

function hasUnsafePathEntry(environment: PlanShellEnvironmentV1, workspaceRoot: string): boolean {
  return environment.pathEntries.some(
    (entry) => entry.length === 0 || !isAbsolute(entry) || isInside(workspaceRoot, entry),
  );
}

async function resolveTrustedExecutable(
  commandName: string | undefined,
  environment: PlanShellEnvironmentV1,
  workspaceRoot: string,
): Promise<PlanShellFileIdentityV1 | undefined> {
  if (commandName === undefined || commandName.length === 0 || commandName.includes("/")) {
    return undefined;
  }
  for (const entry of environment.pathEntries) {
    const lookupPath = join(entry, commandName);
    try {
      const metadata = await lstat(lookupPath);
      if (!metadata.isFile() && !metadata.isSymbolicLink()) {
        return undefined;
      }
      const identity = await readPlanShellFileIdentityV1(lookupPath);
      return (identity.mode & 0o111) !== 0 &&
        (await isTrustedSystemExecutable(identity, workspaceRoot))
        ? identity
        : undefined;
    } catch (error) {
      if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        continue;
      }
      return undefined;
    }
  }
  return undefined;
}

async function isTrustedSystemExecutable(
  identity: PlanShellFileIdentityV1,
  workspaceRoot: string,
): Promise<boolean> {
  const canonicalWorkspace = await realpath(workspaceRoot);
  const canonicalPath = identity.canonicalPath;
  if (
    isInside(canonicalWorkspace, canonicalPath) ||
    (!canonicalPath.startsWith("/usr/bin/") && !canonicalPath.startsWith("/bin/")) ||
    !(await isTrustedLookupChain(identity.lookupPath, canonicalPath))
  ) {
    return false;
  }
  const components = canonicalPath.split("/").filter((component) => component.length > 0);
  let current = "/";
  for (const component of components) {
    current = join(current, component);
    const metadata = await stat(current);
    if (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
      return false;
    }
  }
  return true;
}

async function isTrustedLookupChain(lookupPath: string, canonicalTarget: string): Promise<boolean> {
  if (!isAbsolute(lookupPath) || (await realpath(lookupPath)) !== canonicalTarget) {
    return false;
  }
  const components = lookupPath.split("/").filter((component) => component.length > 0);
  let current = "/";
  for (const component of components) {
    current = join(current, component);
    const metadata = await lstat(current);
    if (metadata.uid !== 0 || (!metadata.isSymbolicLink() && (metadata.mode & 0o022) !== 0)) {
      return false;
    }
  }
  return true;
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
