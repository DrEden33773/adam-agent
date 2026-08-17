import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export class ProjectLifecycleOwnerError extends Error {
  readonly code: "project_in_use" | "project_owner_unavailable";

  constructor(code: ProjectLifecycleOwnerError["code"]) {
    super(
      code === "project_in_use"
        ? "Another process owns lifecycle mutations for this canonical project."
        : "The OS-backed project lifecycle owner is unavailable.",
    );
    this.name = "ProjectLifecycleOwnerError";
    this.code = code;
  }
}

export type ProjectLifecycleOwner = {
  run<T>(operation: () => Promise<T>): Promise<T>;
};

export function createProjectLifecycleOwner(options: {
  readonly workspaceRoot: string;
  readonly stateRoot?: string;
}): ProjectLifecycleOwner {
  return {
    async run(operation) {
      const handle = await acquireProjectLifecycleOwner(options);
      try {
        return await operation();
      } finally {
        await handle.release();
      }
    },
  };
}

type ProjectLifecycleOwnerHandle = {
  release(): Promise<void>;
};

async function acquireProjectLifecycleOwner(options: {
  readonly workspaceRoot: string;
  readonly stateRoot?: string;
}): Promise<ProjectLifecycleOwnerHandle> {
  const canonicalRoot = await realpath(options.workspaceRoot);
  const projectKey = createHash("sha256").update(canonicalRoot).digest("hex");
  const projectDirectory = join(options.stateRoot ?? defaultStateRoot(), "projects", projectKey);
  await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
  await chmod(projectDirectory, 0o700);
  const lockPath = join(projectDirectory, "lifecycle.lock");
  const lockFile = await open(lockPath, "a", 0o600);
  try {
    await lockFile.chmod(0o600);
  } finally {
    await lockFile.close();
  }
  const child = spawn(
    "flock",
    [
      "--exclusive",
      "--nonblock",
      lockPath,
      "/bin/sh",
      "-c",
      "printf 'acquired\\n'; IFS= read -r _",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  await waitForAcquisition(child);
  let released = false;
  return {
    async release() {
      if (released) {
        return;
      }
      released = true;
      await closeOwnerProcess(child);
    },
  };
}

async function waitForAcquisition(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.split("\n").includes("acquired")) {
        finish();
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", () => finish(new ProjectLifecycleOwnerError("project_owner_unavailable")));
    child.once("close", (code) => {
      if (code === 1 && stderr.length === 0) {
        finish(new ProjectLifecycleOwnerError("project_in_use"));
      } else {
        finish(new ProjectLifecycleOwnerError("project_owner_unavailable"));
      }
    });
  });
}

async function closeOwnerProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  child.stdin.end("\n");
  await closed;
}

function defaultStateRoot(): string {
  const { XDG_STATE_HOME: xdgStateHome } = process.env;
  return xdgStateHome === undefined || xdgStateHome.length === 0
    ? join(homedir(), ".local", "state", "adam-agent")
    : join(xdgStateHome, "adam-agent");
}
