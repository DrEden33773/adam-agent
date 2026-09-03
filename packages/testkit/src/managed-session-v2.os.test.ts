import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createJsonlOperationStore } from "@adam-agent/agent";
import { expect, test } from "vitest";

const fixturePath = fileURLToPath(
  new URL("../dist/operation-recovery.fixture.js", import.meta.url),
);
const childMessages = new WeakMap<ChildProcess, unknown[]>();

test("managed v2 wait crash truth and the resumed real operation deadline survive process boundaries", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-v2-process-"));
  const packageRoot = join(testRoot, "extension");
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const deadlineStateRoot = join(testRoot, "deadline-state");
  const deadlineWorkspaceRoot = join(testRoot, "deadline-workspace");
  await mkdir(workspaceRoot);
  await mkdir(deadlineWorkspaceRoot);
  await writeManagedV2ProcessExtension(packageRoot);
  const waitingOwner = spawnFixture({
    mode: "managed-wait-start",
    packageRoot,
    stateRoot,
    workspaceRoot,
  });
  let queryProcess: ChildProcess | undefined;
  let deadlineProcess: ChildProcess | undefined;

  try {
    const waiting = await waitForMessage(waitingOwner, "managed-wait-durable");
    const operationId = messageString(waiting, "operationId");
    await waitForMessage(waitingOwner, "managed-model-started");
    waitingOwner.kill("SIGKILL");
    await waitForClose(waitingOwner);
    const crashedRecords = await createJsonlOperationStore({ stateRoot, workspaceRoot }).then(
      (store) => store.read(operationId),
    );
    expect(crashedRecords.map((record) => record.event.type)).toEqual([
      "operation_started",
      "operation_artifact_published",
      "operation_managed_wait_started",
    ]);

    queryProcess = spawnFixture({
      mode: "managed-query",
      operationId,
      packageRoot,
      stateRoot,
      workspaceRoot,
    });
    const queried = await waitForMessage(queryProcess, "managed-query-completed");
    expect(queried).toMatchObject({
      eventTypes: [
        "operation_started",
        "operation_artifact_published",
        "operation_managed_wait_started",
      ],
      snapshot: { operationId, status: "recovery_required" },
    });
    await waitForClose(queryProcess);

    deadlineProcess = spawnFixture({
      mode: "managed-deadline",
      packageRoot,
      stateRoot: deadlineStateRoot,
      workspaceRoot: deadlineWorkspaceRoot,
    });
    const deadline = await waitForMessage(deadlineProcess, "managed-deadline-terminal");
    expect(deadline).toMatchObject({
      eventTypes: [
        "operation_started",
        "operation_artifact_published",
        "operation_managed_wait_started",
        "operation_managed_wait_settled",
        "operation_failed",
      ],
      snapshot: {
        error: { code: "operation_deadline_exceeded" },
        status: "failed",
      },
    });
    await waitForClose(deadlineProcess);
  } finally {
    for (const child of [waitingOwner, queryProcess, deadlineProcess]) {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForClose(child);
      }
    }
    await rm(testRoot, { recursive: true, force: true });
  }
}, 20_000);

function spawnFixture(options: {
  readonly mode: string;
  readonly operationId?: string;
  readonly packageRoot: string;
  readonly stateRoot: string;
  readonly workspaceRoot: string;
}): ChildProcess {
  const child = spawn(process.execPath, [fixturePath], {
    env: {
      ...process.env,
      ADAM_AGENT_OPERATION_FIXTURE_MODE: options.mode,
      ADAM_AGENT_OPERATION_FIXTURE_PACKAGE_ROOT: options.packageRoot,
      ADAM_AGENT_OPERATION_FIXTURE_STATE_ROOT: options.stateRoot,
      ADAM_AGENT_OPERATION_FIXTURE_WORKSPACE_ROOT: options.workspaceRoot,
      ...(options.operationId === undefined
        ? {}
        : { ADAM_AGENT_OPERATION_FIXTURE_OPERATION_ID: options.operationId }),
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const messages: unknown[] = [];
  childMessages.set(child, messages);
  child.on("message", (message) => messages.push(message));
  return child;
}

async function waitForMessage(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
  const existing = childMessages
    .get(child)
    ?.find((message) => isMessage(message) && message.type === type);
  if (isMessage(existing)) {
    return existing;
  }
  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => {
      child.kill("SIGKILL");
      cleanup();
      reject(new Error(`Child process did not publish ${type}.`));
    }, 5_000);
    const onMessage = (message: unknown) => {
      if (isMessage(message) && message.type === type) {
        cleanup();
        resolve(message);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`Child process closed before ${type}.`));
    };
    const cleanup = () => {
      clearTimeout(guard);
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
  await new Promise<void>((resolve, reject) => {
    const guard = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Child process did not close."));
    }, 5_000);
    child.once("close", () => {
      clearTimeout(guard);
      resolve();
    });
  });
}

function isMessage(value: unknown): value is Record<string, unknown> & { readonly type?: unknown } {
  return typeof value === "object" && value !== null;
}

function messageString(message: Record<string, unknown>, key: string): string {
  const value = message[key];
  if (typeof value !== "string") {
    throw new Error(`Child message did not contain ${key}.`);
  }
  return value;
}

async function writeManagedV2ProcessExtension(packageRoot: string): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/managed-v2-process-extension",
      version: "2.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.extension",
        apiVersion: "^0.5.0",
        runtime: { entry: "./runtime.js" },
        capabilities: {
          required: [
            { id: "adam.artifact.publish@1", version: "^1.0.0" },
            { id: "adam.managed-session@2", version: "^2.0.0" },
          ],
          optional: [],
        },
        contributions: [
          {
            kind: "operation",
            id: "fixture.managed-review-v2",
            input: { id: "fixture.input", version: 1 },
            output: { id: "fixture.output", version: 1 },
            progress: { id: "fixture.progress", version: 1 },
            managedOutput: { id: "fixture.managed-output", version: 1 },
          },
        ],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "runtime.js"),
    `export function activate(context) {
  const codec = (id) => ({ id, version: 1, decode(value) { return { ok: true, value }; }, encode(value) { return { ok: true, value }; } });
  const managedOutput = { id: "fixture.managed-output", version: 1, decode(value) { return value?.verdict === "verified" ? { ok: true, value } : { ok: false, issues: [] }; }, encode(value) { return this.decode(value); } };
  context.registerOperation({
    id: "fixture.managed-review-v2",
    input: codec("fixture.input"), output: codec("fixture.output"), progress: codec("fixture.progress"), managedOutput,
    async execute(_input, operation) {
      const evidence = await operation.capabilities["adam.artifact.publish@1"].publish({ bytes: new TextEncoder().encode("immutable review evidence"), contract: { id: "fixture.review-evidence", version: 1 }, mediaType: "text/plain; charset=utf-8" });
      const terminal = await operation.capabilities["adam.managed-session@2"].run({ evidence: [{ type: "artifact", artifact: evidence }], managedRole: "Review immutable evidence.", output: { id: "fixture.managed-output", version: 1 }, profile: { id: "reviewer.v1", version: 1 }, selectedSkills: [], task: "Return candidates." });
      if (process.env.ADAM_AGENT_OPERATION_FIXTURE_MODE === "managed-deadline") {
        await new Promise((resolve, reject) => {
          const rejectAbort = () => reject(operation.signal.reason);
          if (operation.signal.aborted) rejectAbort();
          else operation.signal.addEventListener("abort", rejectAbort, { once: true });
        });
      }
      return { terminal };
    },
  });
}
`,
    "utf8",
  );
}
