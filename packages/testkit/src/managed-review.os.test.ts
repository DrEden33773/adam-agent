import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createExtensionHost,
  createFileArtifactStore,
  createJsonlOperationStore,
  createPermissionPolicy,
} from "@adam-agent/agent";
import {
  createJsonlManagedAgentControlStore,
  createJsonlSessionStoreDirectory,
  createManagedAgentControl,
  projectExecutionDomainForExtensionHost,
  type SessionRecord,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";

import { createManagedReviewHarness } from "./managed-review-test-support.js";

test("a literal non-Eve extension receives a codec-valid settled managed review through the public capability", async () => {
  const harness = await createManagedReviewHarness({ os: true });
  try {
    const started = await harness.start();
    const events = await withManagedFailureGuard(
      harness.events(started.operationId),
      "Missing settled review",
    );
    const requests = harness.requests;
    expect(events.at(-1)).toMatchObject({
      event: {
        type: "operation_completed",
        output: {
          capabilityKeys: ["review"],
          terminal: {
            status: "completed",
            result: { verdict: "verified" },
            receipt: {
              reviewRunId: expect.any(String),
              evidenceSetDigest: expect.stringMatching(/^sha256:/u),
            },
          },
        },
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools).toEqual([]);
    expect(JSON.stringify(requests[0]?.messages)).toContain("immutable review evidence");
  } finally {
    await harness.close();
  }
});

test.each([
  ["invoked", "recover"],
  ["running", "recover"],
  ["invoked", "cancel"],
  ["running", "cancel"],
] as const)(
  "JSONL review identity survives process death after %s and %s without duplicate admission or provider replay",
  async (phase, action) => {
    const root = await mkdtemp(join(tmpdir(), "adam-review-crash-"));
    const fixture = spawn(
      process.execPath,
      [fileURLToPath(new URL("../dist/managed-review-owner.fixture.js", import.meta.url))],
      {
        env: { ...process.env, ADAM_REVIEW_FIXTURE_ROOT: root, ADAM_REVIEW_FIXTURE_PHASE: phase },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let stderr = "";
    fixture.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const closed = new Promise<void>((resolve) => fixture.once("close", () => resolve()));
    const ready = new Promise<string>((resolve, reject) => {
      fixture.once("error", reject);
      fixture.once("close", () =>
        reject(new Error(`Review fixture closed before ${phase}: ${stderr}`)),
      );
      fixture.on("message", (message: unknown) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "phase" in message &&
          message.phase === phase &&
          "operationId" in message &&
          typeof message.operationId === "string"
        )
          resolve(message.operationId);
      });
    });
    try {
      const operationId = await withManagedFailureGuard(ready, `Missing durable ${phase} barrier`);
      fixture.kill("SIGKILL");
      await withManagedFailureGuard(closed, "Review process did not close");
      const workspaceRoot = join(root, "workspace");
      const stateRoot = join(root, "state");
      const operationStore = await createJsonlOperationStore({ workspaceRoot, stateRoot });
      const before = await operationStore.read(operationId);
      const invocation = before.find(
        (record) => record.event.type === "operation_managed_review_invoked",
      );
      expect(invocation).toBeDefined();
      const controlStore = await createJsonlManagedAgentControlStore({ workspaceRoot, stateRoot });
      expect(
        (await controlStore.read()).filter((record) => record.event.type === "admitted"),
      ).toHaveLength(phase === "invoked" ? 0 : 1);
      const artifactStore = await createFileArtifactStore({ root: join(root, "artifacts") });
      let replayed = false;
      let recoveredControl: ReturnType<typeof createManagedAgentControl> | undefined;
      const host = createExtensionHost({
        artifactStore,
        capabilities: [
          { id: "adam.artifact.publish@1", version: "1.0.0" },
          { id: "adam.managed-review@1", version: "1.0.0" },
        ],
        managedReview: {
          async resolveOrigin({ origin, projectId }) {
            const targetIdentity = {
              targetId: "fixture.review",
              vendor: "fixture",
              modelId: "review",
              route: "direct",
              profileVersion: 1,
              certification: "certified",
            } as const;
            const contextProfile = {
              version: 1,
              contextWindowTokens: 128_000,
              maximumOutputTokens: 4096,
              compactAtTokens: 96_000,
              postCompactTargetTokens: 32_000,
              retainedTargetTokens: 8_000,
              estimatorVersion: 1,
            } as const;
            const executionDomain = projectExecutionDomainForExtensionHost(host);
            if (executionDomain === undefined) throw new Error("Missing cold project domain");
            const model = {
              stream() {
                replayed = true;
                throw new Error("Cold control must not replay a model request");
              },
            };
            recoveredControl ??= createManagedAgentControl({
              parentSessionId: origin.sessionId,
              projectId,
              workspaceRoot,
              executionDomain,
              targetIdentity,
              contextProfile,
              artifactStore,
              permissions: createPermissionPolicy({ allowedEffects: [] }),
              store: controlStore,
              childSessionStores: createJsonlSessionStoreDirectory<SessionRecord>({
                workspaceRoot,
                stateRoot: join(root, "children"),
              }),
              model,
            });
            return {
              status: "ready",
              control: recoveredControl,
              model,
              targetIdentity,
              contextProfile,
            };
          },
        },
        extensions: [
          {
            enabled: true,
            extensionId: "fixture.purpose-review",
            grants: [
              { id: "adam.artifact.publish@1", version: "^1.0.0" },
              { id: "adam.managed-review@1", version: "^1.0.0" },
            ],
            packageName: "@fixture/purpose-review",
            packageRoot: join(root, "extension"),
            packageVersion: "1.0.0",
          },
        ],
        operationOriginAuthority: { validateBoundary: async () => true },
        operationStore,
        projectRoot: workspaceRoot,
        stateRoot,
      });
      await host.loadConfiguredExtensions();
      expect(await host.operations.query(operationId)).toMatchObject({
        status: "recovery_required",
        recoverable: true,
      });
      if (action === "recover")
        expect(await host.operations.recover(operationId)).toMatchObject({
          status: "inspection_required",
          evidence: [expect.objectContaining({ type: "artifact" })],
        });
      else {
        const cancellations = await Promise.allSettled([
          host.operations.cancel(operationId),
          host.operations.cancel(operationId),
        ]);
        expect(cancellations).toMatchObject([
          { status: "fulfilled", value: { status: "cancelled", reason: "caller" } },
          { status: "fulfilled", value: { status: "cancelled", reason: "caller" } },
        ]);
      }
      const after = await operationStore.read(operationId);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(
        after.filter((record) => record.event.type === "operation_managed_review_invoked"),
      ).toHaveLength(1);
      expect(
        (await controlStore.read()).filter((record) => record.event.type === "admitted"),
      ).toHaveLength(phase === "invoked" ? 0 : 1);
      expect(replayed).toBe(false);
      if (action === "cancel" && phase === "running") {
        const snapshot = await recoveredControl?.inspect({
          parentSessionId: "00000000-0000-4000-8000-000000000001",
        });
        expect(snapshot?.storage?.reservedTerminalBytes).toBe(0);
        expect(snapshot?.budget?.unknownReserved).toBeGreaterThan(0);
      }
    } finally {
      fixture.kill("SIGKILL");
      await withManagedFailureGuard(closed, "Review fixture cleanup did not close");
      await rm(root, { recursive: true, force: true });
    }
  },
);
