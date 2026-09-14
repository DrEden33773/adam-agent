import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelDriver, ModelTargets } from "@adam-agent/agent";
import {
  createInMemorySessionStoreDirectory,
  presentationSessionRecordReader,
  type SessionRecord,
  sessionStoreDirectory,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";
import {
  contextProfile,
  createPresentationSession,
  createSessionLifecycle,
  readInMemoryPresentationRecords,
  targetIdentity,
} from "./presentation-session.test-support.js";

test("snapshot activation preserves a newer title and cursor while applying its Plan transition", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-naming-projection-"));
  const workspaceRoot = join(root, "work");
  await mkdir(workspaceRoot);
  const titleStarted = Promise.withResolvers<void>();
  const releaseTitle = Promise.withResolvers<void>();
  const namingVisible = Promise.withResolvers<number>();
  const driver: ModelDriver = {
    async *stream(request) {
      if (request.purpose === "title") {
        titleStarted.resolve();
        await releaseTitle.promise;
        yield { type: "text_delta", text: "Completed title" };
      } else {
        yield { type: "text_delta", text: "Completed answer" };
      }
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            contextProfile,
            readiness: { status: "available", credentialSource: "fixture" },
          },
        ],
      };
    },
  };
  const records = createInMemorySessionStoreDirectory<SessionRecord>();
  const readRecords = readInMemoryPresentationRecords(records);
  const lifecycle = createSessionLifecycle({
    workspaceRoot,
    stateRoot: join(root, "state"),
    modelTargets,
    [sessionStoreDirectory]: records,
  });
  let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;
  let unsubscribe: (() => void) | undefined;
  let armed = false;
  let captured = false;
  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Answer, then enter Plan" },
    });
    await withManagedFailureGuard(titleStarted.promise, "title request started");
    presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      workspaceRoot,
      stateRoot: join(root, "state"),
      projectLabel: "fixture",
      sessionId: created.sessionId,
      [presentationSessionRecordReader]: async (sessionId) => {
        const snapshotRecords = await readRecords(sessionId);
        if (armed && !captured) {
          // No model/metadata work can advance until this explicit Plan activation reads.
          captured = true;
          releaseTitle.resolve();
          await withManagedFailureGuard(namingVisible.promise, "newer naming publication");
        }
        return snapshotRecords;
      },
    });
    const view = presentation;
    expect(view.getState().authoritative.active?.session.naming.generation.status).toBe(
      "in_progress",
    );
    unsubscribe = view.subscribe(() => {
      const state = view.getState().authoritative;
      if (
        state.active?.session.naming.generation.status === "completed" &&
        state.continuity.status === "current"
      ) {
        namingVisible.resolve(state.continuity.sessionThroughSequence);
      }
    });
    armed = true;
    await expect(
      view.dispatch({ type: "enter_plan", sessionId: created.sessionId }),
    ).resolves.toMatchObject({ status: "admitted" });
    const observedSequence = await namingVisible.promise;
    const state = view.getState().authoritative;
    expect(captured).toBe(true);
    expect(state.active?.plan?.state).toBe("exploring");
    expect(state.active?.session.status).toBe("settled");
    expect(state.active?.session.naming).toMatchObject({
      generatedTitle: "Completed title",
      generation: { status: "completed" },
    });
    expect(state.continuity).toMatchObject({
      status: "current",
      sessionThroughSequence: observedSequence,
    });
  } finally {
    releaseTitle.resolve();
    namingVisible.resolve(0);
    unsubscribe?.();
    await presentation?.close();
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});
