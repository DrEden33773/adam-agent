import {
  createModelTargets,
  type ModelRequest,
  resolveThinkingPolicy,
  selectModelTargetId,
} from "@adam-agent/agent";
import { expect, test } from "vitest";

const identity = {
  targetId: "deepseek-flash.direct",
  vendor: "deepseek",
  modelId: "deepseek-flash",
  route: "direct",
  profileVersion: 4,
  certification: "certified",
} as const;

test("Flash advertises the recommended stable image target and retains hidden legacy targets", async () => {
  const targets = createModelTargets({ environment: {} });
  const snapshot = await targets.snapshot({ signal: new AbortController().signal });
  expect(snapshot.targets[0]).toMatchObject({
    identity,
    catalog: {
      displayName: "DeepSeek V4.1 Flash",
      recommended: true,
      modalities: ["text", "image"],
      capabilities: ["reasoning", "tool-use"],
    },
    upstreamLifecycle: "stable",
    readiness: { status: "missing", credentialSource: "DEEPSEEK_API_KEY" },
    modalityProfile: { explicitUserImages: "unsupported", imageToolResults: "supported" },
    contextProfile: { version: 2, contextWindowTokens: 1_000_000, maximumOutputTokens: 384_000 },
    thinkingCapability: {
      defaultLevelId: "high",
      providerProfile: { id: "deepseek/responses", requestPath: "reasoning.effort" },
      levels: [{ id: "off" }, { id: "low" }, { id: "high" }, { id: "max" }],
    },
  });
  expect(
    snapshot.targets
      .filter(
        (target) => target.identity.vendor === "deepseek" && !target.catalog?.hiddenFromPicker,
      )
      .map((target) => target.identity.targetId),
  ).toEqual(["deepseek-flash.direct", "deepseek-v4-pro.direct"]);
  expect(
    snapshot.targets
      .filter((target) => target.catalog?.hiddenFromPicker)
      .map((target) => target.identity.targetId),
  ).toEqual(["deepseek-v4-flash.direct", "deepseek-v4-flash-vision-exp.direct"]);
  expect(
    selectModelTargetId({ ADAM_AGENT_PROVIDER: "deepseek", ADAM_AGENT_MODEL: "deepseek-flash" }),
  ).toBe(identity.targetId);
  expect(selectModelTargetId({ ADAM_AGENT_PROVIDER: "deepseek" })).toBe("deepseek-v4-pro.direct");
});

test.each(["off", "low", "high", "max"])(
  "Flash sends the canonical Responses model and %s thinking policy",
  async (level) => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const targets = createModelTargets({
      environment: { DEEPSEEK_API_KEY: "test-key" },
      fetch: async (input, init) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return new Response(
          'data: {"type":"response.output_text.delta","delta":"Flash answer"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        );
      },
    });
    const target = await targets.resolve({
      targetId: identity.targetId,
      allowExperimental: false,
      signal: new AbortController().signal,
    });
    expect(target.identity).toEqual(identity);
    expect(target.upstreamLifecycle).toBe("stable");
    expect(target.thinkingCapability).toBeDefined();
    if (target.thinkingCapability === undefined) throw new Error("Missing thinking capability");
    for (const purpose of [undefined, "title", "compaction"] as const) {
      const request: ModelRequest = {
        messages: [{ role: "user", content: "Answer this call." }],
        tools: [],
        maximumOutputTokens: 2_048,
        signal: new AbortController().signal,
        thinkingPolicy: resolveThinkingPolicy(target.thinkingCapability, level, identity),
        ...(purpose === undefined ? {} : { purpose }),
      };
      const events = [];
      for await (const event of target.driver.stream(request)) events.push(event);
      expect(events).toContainEqual({ type: "text_delta", text: "Flash answer" });
      expect(events).toContainEqual({ type: "finish", reason: "stop", rawReason: "completed" });
    }
    expect(requests).toEqual(
      Array.from({ length: 3 }, () => ({
        url: "https://api.deepseek.com/responses",
        body: {
          model: "deepseek-flash",
          input: [{ role: "user", content: "Answer this call." }],
          max_output_tokens: 2_048,
          stream: true,
          reasoning: { effort: level === "off" ? "none" : level },
        },
      })),
    );
  },
);

test("Flash connection check accepts the official canonical model catalog", async () => {
  const requests: string[] = [];
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-key" },
    fetch: async (input) => {
      requests.push(String(input));
      return Response.json({ data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] });
    },
  });
  await expect(
    targets.testConnection?.({ targetId: identity.targetId, signal: new AbortController().signal }),
  ).resolves.toEqual({ status: "reachable", diagnostic: null });
  expect(requests).toEqual(["https://api.deepseek.com/models"]);
});
