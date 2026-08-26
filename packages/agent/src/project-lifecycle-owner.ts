import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  fchmod as chmodFileDescriptor,
  close as closeFileDescriptor,
  open as openFileDescriptor,
} from "node:fs";
import { chmod, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";

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
  acquire(): Promise<ProjectLifecycleOwnerLease>;
  run<T>(operation: () => Promise<T>): Promise<T>;
};

export type ProjectLifecycleOwnerLease = {
  release(): Promise<void>;
};

export function createProjectLifecycleOwner(options: {
  readonly workspaceRoot: string;
  readonly stateRoot?: string;
}): ProjectLifecycleOwner {
  const acquire = () => acquireProjectLifecycleOwner(options);
  return {
    acquire,
    async run(operation) {
      const handle = await acquire();
      try {
        return await operation();
      } finally {
        await handle.release();
      }
    },
  };
}

async function acquireProjectLifecycleOwner(options: {
  readonly workspaceRoot: string;
  readonly stateRoot?: string;
}): Promise<ProjectLifecycleOwnerLease> {
  const canonicalRoot = await realpath(options.workspaceRoot);
  const projectKey = createHash("sha256").update(canonicalRoot).digest("hex");
  const projectDirectory = join(options.stateRoot ?? defaultStateRoot(), "projects", projectKey);
  await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
  await chmod(projectDirectory, 0o700);
  const lockPath = join(projectDirectory, "lifecycle.lock");
  const lockFileDescriptor = await openLockFileDescriptor(lockPath);
  try {
    await chmodLockFileDescriptor(lockFileDescriptor);
    const child = spawn("flock", ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "pipe", lockFileDescriptor],
    });
    await waitForAcquisition(child);
  } catch (error) {
    await closeLockFileDescriptor(lockFileDescriptor);
    throw error;
  }
  const keepAlive = new MessageChannel();
  keepAlive.port1.ref();
  keepAlive.port2.ref();
  let releasePromise: Promise<void> | undefined;
  return {
    release() {
      releasePromise ??= closeLockFileDescriptor(lockFileDescriptor).finally(() => {
        keepAlive.port1.close();
        keepAlive.port2.close();
      });
      return releasePromise;
    },
  };
}

async function waitForAcquisition(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
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
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", () => finish(new ProjectLifecycleOwnerError("project_owner_unavailable")));
    child.once("close", (code) => {
      if (code === 0) {
        finish();
      } else if (code === 1 && stderr.length === 0) {
        finish(new ProjectLifecycleOwnerError("project_in_use"));
      } else {
        finish(new ProjectLifecycleOwnerError("project_owner_unavailable"));
      }
    });
  });
}

async function openLockFileDescriptor(path: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    openFileDescriptor(path, "a", 0o600, (error, fileDescriptor) => {
      if (error === null) {
        resolve(fileDescriptor);
      } else {
        reject(error);
      }
    });
  });
}

async function chmodLockFileDescriptor(fileDescriptor: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    chmodFileDescriptor(fileDescriptor, 0o600, (error) => {
      if (error === null) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

async function closeLockFileDescriptor(fileDescriptor: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    closeFileDescriptor(fileDescriptor, (error) => {
      if (error === null) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

function defaultStateRoot(): string {
  const { XDG_STATE_HOME: xdgStateHome } = process.env;
  return xdgStateHome === undefined || xdgStateHome.length === 0
    ? join(homedir(), ".local", "state", "adam-agent")
    : join(xdgStateHome, "adam-agent");
}
