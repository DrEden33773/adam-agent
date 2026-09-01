import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createProjectExecutionDomain,
  createProjectLifecycleOwner,
  ProjectExecutionDomainError,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";

const ownerFixturePath = fileURLToPath(
  new URL("../dist/project-execution-domain-owner.fixture.js", import.meta.url),
);

test("ProjectExecutionDomain keeps the real flock until the final child claim releases", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-project-domain-flock-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const first = createProjectExecutionDomain({
    lifecycleOwner: createProjectLifecycleOwner({ stateRoot, workspaceRoot }),
  });
  const second = createProjectExecutionDomain({
    lifecycleOwner: createProjectLifecycleOwner({ stateRoot, workspaceRoot }),
  });

  try {
    const root = await first.claimRoot({ rootId: "parent-session" });
    const child = await root.claimChild({ childId: "child-1" });
    await root.release();

    await expect(second.claimRoot({ rootId: "other-session" })).rejects.toEqual(
      new ProjectExecutionDomainError("project_in_use"),
    );

    await child.release();
    const admitted = await second.claimRoot({ rootId: "other-session" });
    await admitted.release();
  } finally {
    await first.close();
    await second.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ProjectExecutionDomain restart loses live claims without retaining the real flock", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-project-domain-restart-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const owner = spawn(process.execPath, [ownerFixturePath], {
    env: {
      ...process.env,
      ADAM_AGENT_FIXTURE_STATE_ROOT: stateRoot,
      ADAM_AGENT_FIXTURE_WORKSPACE_ROOT: workspaceRoot,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });

  try {
    await waitForMessage(owner, "child-held");
    owner.kill("SIGKILL");
    await waitForClose(owner);
    const restarted = createProjectExecutionDomain({
      lifecycleOwner: createProjectLifecycleOwner({ stateRoot, workspaceRoot }),
    });

    const admitted = await restarted.claimRoot({ rootId: "new-session" });
    await admitted.release();
    await restarted.close();
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill("SIGKILL");
      await waitForClose(owner);
    }
    await rm(testRoot, { recursive: true, force: true });
  }
});

async function waitForMessage(child: ChildProcess, expected: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (message === expected) {
        cleanup();
        resolve();
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`Fixture closed before publishing ${expected}.`));
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("close", onClose);
    };
    child.on("message", onMessage);
    child.once("close", onClose);
  });
}

async function waitForClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
}
