import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelDriver, ModelRequest, ModelTargets } from "@adam-agent/agent";
import { expect, onTestFinished, test } from "vitest";
import { type ManagedTuiFixture, startManagedTui } from "./agent-fleet.test-support.js";
import { terminalObservationTimeoutMilliseconds } from "./virtual-terminal.test-support.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const identity = {
  targetId: "deepseek-flash.direct",
  vendor: "deepseek",
  modelId: "deepseek-flash",
  route: "direct",
  profileVersion: 4,
  certification: "certified",
} as const;
const contextProfile = {
  version: 2,
  contextWindowTokens: 1_000_000,
  maximumOutputTokens: 384_000,
  ordinaryOutputReserveTokens: 4096,
  compactionSummaryMaximumOutputTokens: 32_768,
  compactAtTokens: 900_000,
  postCompactTargetTokens: 200_000,
  retainedTargetTokens: 20_000,
  estimatorVersion: 1,
} as const;

function imageModel() {
  const requests: ModelRequest[] = [];
  const driver: ModelDriver = {
    async *stream(request) {
      requests.push(request);
      const image = request.messages.findLast(
        (message) => message.role === "tool" && message.name === "read_input_resource",
      );
      if (image === undefined) {
        const id = JSON.stringify(request.messages).match(/[a-f0-9-]{36}:input:\d+/u)?.[0];
        if (id === undefined) {
          yield { type: "text_delta", text: "Text turn received." };
          yield { type: "finish", reason: "stop" };
          return;
        }
        yield { type: "tool_call_start", id: "view-image", name: "read_input_resource" };
        yield {
          type: "tool_call_delta",
          id: "view-image",
          json: JSON.stringify({ occurrenceId: id }),
        };
        yield { type: "tool_call_end", id: "view-image" };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        expect(image).toMatchObject({
          result: { status: "completed", output: { type: "image", width: 1, height: 1 } },
          content: [{ type: "file", mediaType: "image/png", bytes: new Uint8Array(png) }],
        });
        yield { type: "text_delta", text: `Immutable image received. Request ${requests.length}.` };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity,
        contextProfile,
        driver,
        modalityProfile: {
          profileVersion: 1,
          explicitUserImages: "unsupported",
          imageToolResults: "supported",
        },
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity,
            contextProfile,
            modalityProfile: {
              profileVersion: 1,
              explicitUserImages: "unsupported",
              imageToolResults: "supported",
            },
            catalog: {
              displayName: "Flash",
              summary: "Image fixture",
              capabilities: ["tool-use"],
              modalities: ["text", "image"],
              recommended: true,
            },
            readiness: { status: "available", credentialSource: "test" },
          },
        ],
      };
    },
  };
  return { driver, modelTargets, requests };
}

function observe(register: (done: () => void) => () => void, missing: string): Promise<void> {
  let unsubscribe = () => {};
  let guard: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    if (guard !== undefined) clearTimeout(guard);
    unsubscribe();
  };
  const promise = new Promise<void>((resolve, reject) => {
    guard = setTimeout(() => {
      cleanup();
      reject(new Error(missing));
    }, terminalObservationTimeoutMilliseconds);
    unsubscribe = register(() => {
      cleanup();
      resolve();
    });
  });
  onTestFinished(cleanup);
  void promise.catch(() => {});
  return promise;
}

function nextMainSettlement(h: ManagedTuiFixture): Promise<void> {
  let runId: string | undefined;
  return observe(
    (done) =>
      h.lifecycle.subscribeSessionEvents((event) => {
        if (event.sessionId !== h.parent.sessionId) return;
        if (event.event.type === "user_message") runId = event.runId;
        if (runId !== undefined && event.runId === runId && event.event.type === "session_settled")
          done();
      }),
    `Missing next Main settlement for ${h.parent.sessionId}`,
  );
}

function childOutcome(h: ManagedTuiFixture, summary: string): Promise<void> {
  return observe((done) => {
    const check = () => {
      if (
        h.presentation
          .getState()
          .authoritative.managedControl?.threads.some(
            (thread) =>
              thread.handle === "@explore-1" &&
              thread.turn.phase === "idle" &&
              thread.turn.outcome?.summary === summary,
          )
      )
        done();
    };
    const unsubscribe = h.presentation.subscribe(check);
    queueMicrotask(check);
    return unsubscribe;
  }, `Missing completed @explore-1 outcome: ${summary}`);
}

test("image preparation owns concurrent submissions, session switching and cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-image-admission-"));
  await writeFile(join(root, "image.png"), png);
  const entered = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  const model = imageModel();
  const h = await startManagedTui(model.driver, {
    workspaceRoot: root,
    targetIdentity: identity,
    modelTargets: model.modelTargets,
    stageBarrier: {
      async afterOpen({ signal }) {
        entered.resolve(signal);
        await release.promise;
      },
    },
  });
  let first: ReturnType<typeof h.presentation.dispatch> | undefined;
  try {
    const command = {
      type: "submit_prompt",
      sessionId: h.parent.sessionId,
      text: "Inspect @image.png",
      skills: [],
      thinkingSelection: null,
    } as const;
    first = h.presentation.dispatch(command);
    await expect(h.presentation.dispatch(command)).resolves.toMatchObject({
      status: "rejected",
      code: "conflict",
    });
    let signal: AbortSignal | undefined;
    await observe((done) => {
      void entered.promise.then((value) => {
        signal = value;
        done();
      });
      return () => {};
    }, "Image staging did not open the selected file.");
    await expect(
      h.presentation.dispatch({ type: "create_session", targetId: identity.targetId }),
    ).resolves.toMatchObject({ status: "rejected", code: "conflict" });
    await expect(
      h.presentation.dispatch({ type: "cancel_run", sessionId: h.parent.sessionId }),
    ).resolves.toMatchObject({ status: "admitted" });
    expect(signal?.aborted).toBe(true);
    release.resolve();
    await expect(first).resolves.toMatchObject({ status: "rejected" });
    expect(h.presentation.getState().composer.renderedText).toBe("Inspect @image.png");
    expect(h.presentation.getState().composer.resources).toHaveLength(0);
    expect(model.requests).toHaveLength(0);
    const settled = nextMainSettlement(h);
    await expect(h.presentation.dispatch(command)).resolves.toMatchObject({ status: "admitted" });
    await settled;
    expect(model.requests).toHaveLength(2);
  } finally {
    release.resolve();
    await first;
    await h.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation at the persisted-image boundary keeps the saved image and prevents provider admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-image-commit-cancel-"));
  await writeFile(join(root, "image.png"), png);
  const model = imageModel();
  const h = await startManagedTui(model.driver, {
    workspaceRoot: root,
    targetIdentity: identity,
    modelTargets: model.modelTargets,
    draftPersistencePolicy: "recoverable",
  });
  let cancellation: ReturnType<typeof h.presentation.dispatch> | undefined;
  const unsubscribe = h.presentation.subscribe(() => {
    const state = h.presentation.getState();
    if (
      cancellation === undefined &&
      !state.composer.sealed &&
      state.composer.resources.length === 1 &&
      state.authoritative.active?.parentRun?.phase === "running"
    ) {
      // Set the guard before dispatch: cancellation itself publishes another snapshot.
      cancellation = Promise.resolve({
        status: "rejected",
        code: "conflict",
        message: "pending cancellation",
      });
      cancellation = h.presentation.dispatch({ type: "cancel_run", sessionId: h.parent.sessionId });
    }
  });
  try {
    const receipt = await h.presentation.dispatch({
      type: "submit_prompt",
      sessionId: h.parent.sessionId,
      text: "Inspect @image.png",
      skills: [],
      thinkingSelection: null,
    });
    expect(receipt.status).toBe("rejected");
    await expect(cancellation).resolves.toMatchObject({ status: "admitted" });
    expect(model.requests).toHaveLength(0);
    expect(h.presentation.getState().composer.renderedText).toBe("Inspect [Image #1]");
  } finally {
    unsubscribe();
    await h.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a continued Main session accepts an image reference and replays immutable bytes after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-image-main-resume-"));
  await writeFile(join(root, "image.png"), png);
  const model = imageModel();
  const options = {
    workspaceRoot: root,
    targetIdentity: identity,
    modelTargets: model.modelTargets,
  };
  let h = await startManagedTui(model.driver, options);
  try {
    const firstSettled = nextMainSettlement(h);
    await h.press("Inspect @image.png\r", "Immutable image received.");
    await firstSettled;
    expect(model.requests).toHaveLength(2);
    await h.stop();
    await rm(join(root, "image.png"));
    h = await startManagedTui(model.driver, { ...options, restore: h.storage });
    const secondSettled = nextMainSettlement(h);
    await h.press("Describe the same image again.\r", "Request 3.");
    await secondSettled;
    expect(model.requests).toHaveLength(3);
  } finally {
    await h.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("direct child input accepts an image reference and retains its image capability on cold continuation", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-image-child-resume-"));
  await writeFile(join(root, "image.png"), png);
  const model = imageModel();
  const options = {
    workspaceRoot: root,
    targetIdentity: identity,
    modelTargets: model.modelTargets,
  };
  let h = await startManagedTui(model.driver, options);
  try {
    await h.press("@Explore", "New agent · Explore");
    await h.press("\t", "@Explore");
    await h.press(" Start this task.\r", "Delegation");
    await h.press("\r", "Completed");
    await h.press("@explore-1", "[Agent] @explore-1");
    await h.press("\t", "@explore-1");
    await h.press(" Inspect @image.png\r", "Delegation");
    await h.press("\r", "Input accepted for @explore-1");
    await childOutcome(h, "Immutable image received. Request 3.");
    expect(model.requests).toHaveLength(3);
    await h.stop();
    await rm(join(root, "image.png"));
    h = await startManagedTui(model.driver, { ...options, restore: h.storage });
    await h.press("@explore-1", "[Agent] @explore-1");
    await h.press("\t", "@explore-1");
    await h.press(" Inspect the retained image again.\r", "Delegation");
    await h.press("\r", "Input accepted for @explore-1");
    await childOutcome(h, "Immutable image received. Request 4.");
    expect(model.requests).toHaveLength(4);
  } finally {
    await h.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a text-only target keeps one converted image after rejected sends", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-image-target-rejection-"));
  await writeFile(join(root, "image.png"), png);
  let calls = 0;
  const driver: ModelDriver = {
    async *stream() {
      calls += 1;
      yield { type: "finish", reason: "stop" };
    },
  };
  const h = await startManagedTui(driver, { workspaceRoot: root, blankDraft: true });
  try {
    await h.press("Inspect @image.png\r", "The exact target does not support images.");
    expect(h.presentation.getState().composer.renderedText).toBe("Inspect [Image #1]");
    expect(h.terminal.lines().join("\n")).not.toContain("@image.png");
    await h.press("\r", "The exact target does not support images.");
    expect(h.presentation.getState().composer.resources).toHaveLength(1);
    expect(calls).toBe(0);
  } finally {
    await h.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["completion", "typed", "paste", "plan", "role"])(
  "production TUI sends %s image references through the image tool",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "adam-image-tui-"));
    const path = join(root, "image.png");
    await writeFile(path, png);
    const model = imageModel();
    const h = await startManagedTui(model.driver, {
      workspaceRoot: root,
      blankDraft: true,
      targetIdentity: identity,
      modelTargets: model.modelTargets,
    });
    try {
      if (mode === "plan")
        expect(
          await h.presentation.dispatch({ type: "set_draft_mode", mode: "plan" }),
        ).toMatchObject({ status: "admitted" });
      if (mode === "role") {
        await h.press("@Explore", "New agent · Explore");
        await h.press("\t", "@Explore");
        await h.press(" Inspect @image.png", "Inspect @image.png");
        await h.press("\r", "Delegation");
        await h.press("\r", "Completed");
      } else if (mode === "completion") {
        await h.press("Inspect @image", "[File] image.png");
        await h.press("\t", "[Image #1]");
        await h.press("\u007f", "Draft element removed.");
        await h.press("\u001f", "Draft edit undone.");
        expect(h.presentation.getState().composer.resources).toHaveLength(1);
        await rm(path);
        await h.press("\r", "Immutable image received.");
      } else {
        await h.press(
          mode === "paste" ? "\x1b[200~Inspect @image.png\x1b[201~" : "Inspect @image.png",
          "Inspect @image.png",
        );
        await h.press("\r", "Immutable image received.");
      }
      expect(model.requests).toHaveLength(2);
      expect(model.requests[0]?.messages.filter((message) => message.role === "user")).toHaveLength(
        1,
      );
      expect(
        model.requests[1]?.messages.some(
          (message) => message.role === "tool" && message.name === "read_file",
        ),
      ).toBe(false);
    } finally {
      await h.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
