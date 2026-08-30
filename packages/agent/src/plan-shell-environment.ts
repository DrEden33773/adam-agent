import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";

export type PlanShellFileIdentityV1 = {
  readonly lookupPath: string;
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly size: number;
  readonly modifiedMilliseconds: number;
  readonly digest: `sha256:${string}`;
};

export type PlanShellUnavailableV1 = {
  readonly status: "unavailable";
  readonly lookupPath: "/bin/sh";
};

export type PlanShellEnvironmentV1 = {
  readonly version: "plan-shell-env.v1";
  readonly pathEntries: readonly string[];
  readonly variables: {
    readonly PATH: string;
    readonly LANG: "C";
    readonly LC_ALL: "C";
    readonly TERM: "dumb";
    readonly TMPDIR: string;
  };
  readonly home: { readonly allocation: "owner-only-empty-per-call" };
  readonly shell: PlanShellFileIdentityV1 | PlanShellUnavailableV1;
  readonly digest: `sha256:${string}`;
};

export async function createPlanShellEnvironmentV1(): Promise<PlanShellEnvironmentV1> {
  const { PATH: executablePath = "" } = process.env;
  const shell = await readPlanShellFileIdentityV1("/bin/sh").catch(
    (): PlanShellUnavailableV1 => ({ status: "unavailable", lookupPath: "/bin/sh" }),
  );
  const environment = {
    version: "plan-shell-env.v1" as const,
    pathEntries: executablePath.split(":"),
    variables: {
      PATH: executablePath,
      LANG: "C" as const,
      LC_ALL: "C" as const,
      TERM: "dumb" as const,
      TMPDIR: await realpath(tmpdir()),
    },
    home: { allocation: "owner-only-empty-per-call" as const },
    shell,
  };
  return { ...environment, digest: digest(environment) };
}

/** Tests only: a deterministic snapshot for semantic lifecycle tests. */
export function createUnavailablePlanShellEnvironmentV1(): PlanShellEnvironmentV1 {
  const environment = {
    version: "plan-shell-env.v1" as const,
    pathEntries: ["/usr/bin", "/bin"],
    variables: {
      PATH: "/usr/bin:/bin",
      LANG: "C" as const,
      LC_ALL: "C" as const,
      TERM: "dumb" as const,
      TMPDIR: "/tmp",
    },
    home: { allocation: "owner-only-empty-per-call" as const },
    shell: { status: "unavailable" as const, lookupPath: "/bin/sh" as const },
  };
  return { ...environment, digest: digest(environment) };
}

export function isPlanShellEnvironmentV1Valid(environment: PlanShellEnvironmentV1): boolean {
  const { digest: environmentDigest, ...withoutDigest } = environment;
  return (
    environment.version === "plan-shell-env.v1" &&
    environment.pathEntries.length > 0 &&
    environment.pathEntries.length <= 128 &&
    environment.pathEntries.every(
      (entry) => Buffer.byteLength(entry, "utf8") <= 4_096 && !entry.includes("\0"),
    ) &&
    environment.variables.PATH === environment.pathEntries.join(":") &&
    Buffer.byteLength(environment.variables.PATH, "utf8") <= 16_384 &&
    environment.variables.LANG === "C" &&
    environment.variables.LC_ALL === "C" &&
    environment.variables.TERM === "dumb" &&
    environment.variables.TMPDIR.startsWith("/") &&
    environment.home.allocation === "owner-only-empty-per-call" &&
    isPlanShellSnapshotValid(environment.shell) &&
    environmentDigest === digest(withoutDigest)
  );
}

function isPlanShellSnapshotValid(shell: PlanShellEnvironmentV1["shell"]): boolean {
  if ("status" in shell) {
    return shell.status === "unavailable" && shell.lookupPath === "/bin/sh";
  }
  return (
    shell.lookupPath === "/bin/sh" &&
    shell.canonicalPath.startsWith("/") &&
    /^\d+$/u.test(shell.device) &&
    /^\d+$/u.test(shell.inode) &&
    Number.isSafeInteger(shell.mode) &&
    shell.mode >= 0 &&
    Number.isSafeInteger(shell.size) &&
    shell.size >= 0 &&
    shell.size <= 8 * 1024 * 1024 &&
    Number.isFinite(shell.modifiedMilliseconds) &&
    shell.modifiedMilliseconds >= 0 &&
    /^sha256:[0-9a-f]{64}$/u.test(shell.digest)
  );
}

export async function readPlanShellFileIdentityV1(
  lookupPath: string,
): Promise<PlanShellFileIdentityV1> {
  const canonicalPath = await realpath(lookupPath);
  const metadata = await stat(canonicalPath, { bigint: true });
  if (!metadata.isFile() || metadata.size > 8n * 1024n * 1024n) {
    throw new TypeError("The Plan shell target is not a bounded ordinary file.");
  }
  const bytes = await readFile(canonicalPath);
  return {
    lookupPath,
    canonicalPath,
    device: metadata.dev.toString(10),
    inode: metadata.ino.toString(10),
    mode: Number(metadata.mode),
    size: Number(metadata.size),
    modifiedMilliseconds: Number(metadata.mtimeMs),
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}
