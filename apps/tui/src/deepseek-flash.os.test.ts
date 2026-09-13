import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModelTargets,
  createPresentationPreferences,
  createPresentationSession,
  createSessionLifecycle,
} from "@adam-agent/agent";
import {
  createTrustedWorkspaceTrustForTesting,
  sessionAutomaticTitlesEnabled,
} from "@adam-agent/agent/internal-testing";
import { expect, test, vi } from "vitest";
import { TargetPicker } from "./target-picker.js";
import { createAdamTuiTheme } from "./theme.js";

const flashIdentity = {
  targetId: "deepseek-flash.direct",
  vendor: "deepseek",
  modelId: "deepseek-flash",
  route: "direct",
  profileVersion: 4,
  certification: "certified",
} as const;

test("the real target catalog hides legacy picker rows while saved and explicit targets survive restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-flash-picker-"));
  const workspaceRoot = join(root, "project");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  const preferences = createPresentationPreferences({
    environment: { XDG_CONFIG_HOME: join(root, "config") },
  });
  const modelTargets = createModelTargets({ environment: { DEEPSEEK_API_KEY: "test-key" } });
  const lifecycle = createSessionLifecycle({
    modelTargets,
    workspaceRoot,
    stateRoot,
    workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
    [sessionAutomaticTitlesEnabled]: false,
  });
  try {
    for (const targetId of [
      "deepseek-v4-flash.direct",
      "deepseek-v4-flash-vision-exp.direct",
      "deepseek-flash.direct",
    ]) {
      const presentation = await createPresentationSession({
        lifecycle,
        modelTargets,
        preferences,
        workspaceRoot,
        stateRoot,
        projectLabel: "project",
        openProject: true,
      });
      try {
        const targets = presentation.getState().authoritative.targets;
        const onSelect = vi.fn();
        const picker = new TargetPicker({
          targets: targets.items,
          columns: () => 120,
          maximumContentRows: () => 36,
          theme: createAdamTuiTheme(true),
          defaultTargetId: targetId,
          onClose: vi.fn(),
          onCheckConnection: vi.fn(),
          onSelect,
          onSetDefault: vi.fn(),
        });
        const screen = picker.render(120).join("\n");
        expect(screen).toContain("DeepSeek V4.1 Flash");
        expect(screen).toContain("DeepSeek V4 Pro");
        expect(screen).toContain("RECOMMENDED");
        expect(screen).not.toContain("DeepSeek V4 Flash");
        expect(screen).toContain("image");
        picker.handleInput("\r");
        expect(onSelect).toHaveBeenCalledWith(
          expect.objectContaining({ targetId: "deepseek-flash.direct" }),
        );
        await expect(
          presentation.dispatch({ type: "set_default_target", targetId }),
        ).resolves.toMatchObject({ status: "admitted" });
        await expect(
          presentation.dispatch({ type: "create_session", targetId }),
        ).resolves.toMatchObject({ status: "admitted" });
        expect(presentation.getState().draft?.targetId).toBe(targetId);
      } finally {
        await presentation.close();
      }
      const reopened = await createPresentationSession({
        lifecycle,
        modelTargets,
        preferences: createPresentationPreferences({
          environment: { XDG_CONFIG_HOME: join(root, "config") },
        }),
        workspaceRoot,
        stateRoot,
        projectLabel: "project",
        openProject: true,
      });
      try {
        expect(reopened.getState().authoritative.targets).toMatchObject({
          defaultTargetId: targetId,
          diagnostic: null,
        });
      } finally {
        await reopened.close();
      }
    }
  } finally {
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Flash reads an image through Responses tools and cold-resumes its exact profile and image history", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-flash-image-"));
  const workspaceRoot = join(root, "project");
  const stateRoot = join(root, "state");
  const imagePath = join(root, "pixel.png");
  const imageBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  await mkdir(workspaceRoot);
  await writeFile(imagePath, Buffer.from(imageBase64, "base64"));
  const runId = "80000000-0000-4000-8000-000000000001";
  let ordinaryCalls = 0;
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-key" },
    fetch: async (input, init) => {
      expect(String(input)).toBe("https://api.deepseek.com/responses");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("deepseek-flash");
      ordinaryCalls += 1;
      if (ordinaryCalls === 1) {
        expect(JSON.stringify(body.input)).not.toContain("data:image/png;base64,");
        return sse([
          {
            type: "response.output_item.added",
            item: {
              type: "function_call",
              id: "image-item",
              call_id: "image-call",
              name: "read_input_resource",
            },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "image-item",
            delta: JSON.stringify({ occurrenceId: `${runId}:input:1` }),
          },
          { type: "response.output_item.done", item: { type: "function_call", id: "image-item" } },
          { type: "response.completed", response: { status: "completed" } },
        ]);
      }
      expect(body.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "function_call_output",
            call_id: "image-call",
            output: expect.arrayContaining([
              expect.objectContaining({
                type: "input_image",
                image_url: `data:image/png;base64,${imageBase64}`,
              }),
            ]),
          }),
        ]),
      );
      return sse([
        { type: "response.output_text.delta", delta: "Image inspected." },
        { type: "response.completed", response: { status: "completed" } },
      ]);
    },
  });
  const options = {
    modelTargets,
    workspaceRoot,
    stateRoot,
    workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
    [sessionAutomaticTitlesEnabled]: false,
  };
  const warm = createSessionLifecycle(options);
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;
  try {
    const created = await warm.create({ targetIdentity: flashIdentity });
    await expect(
      warm.continue({
        sessionId: created.sessionId,
        runId,
        input: { text: "Read the attached image." },
        resourceSelections: [{ type: "local_file", path: imagePath }],
      }),
    ).resolves.toMatchObject({ result: { status: "completed", answer: "Image inspected." } });
    expect(ordinaryCalls).toBe(2);
    await warm.close();
    await rm(imagePath);
    cold = createSessionLifecycle(options);
    await expect(cold.resume({ sessionId: created.sessionId })).resolves.toMatchObject({
      status: "ready",
      snapshot: { targetIdentity: flashIdentity },
    });
    expect(ordinaryCalls).toBe(2);
    await expect(
      cold.continue({
        sessionId: created.sessionId,
        input: { text: "Use the same image history." },
      }),
    ).resolves.toMatchObject({ result: { status: "completed", answer: "Image inspected." } });
    expect(ordinaryCalls).toBe(3);
  } finally {
    await cold?.close();
    await warm.close();
    await rm(root, { recursive: true, force: true });
  }
});

function sse(events: readonly unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
