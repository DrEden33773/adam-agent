import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentSession,
  createInMemorySessionStore,
  createModelTargets,
  createPermissionPolicy,
  createReadToolRegistry,
  ModelDriverError,
  type ModelEvent,
  ModelTargetError,
  type ModelTargetIdentity,
  OpenAICompatibleModelDriver,
  type RuntimeEvent,
  resolveThinkingPolicy,
  selectModelTargetId,
} from "@adam-agent/agent";
import { AiSdkModelDriverForTesting } from "@adam-agent/agent/internal-testing";
import { expect, test, vi } from "vitest";

test("an exact Direct DeepSeek target returns a public answer-only model driver", async () => {
  const requests: Array<{ readonly url: string; readonly body: unknown }> = [];
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async (input, init) => {
      requests.push({
        url: input instanceof Request ? input.url : String(input),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  });

  const resolved = await targets.resolve({
    targetId: "deepseek-v4-flash.direct",
    allowExperimental: false,
    signal: new AbortController().signal,
  });
  const events = await collect(
    resolved.driver.stream({
      messages: [{ role: "user", content: "Introduce yourself" }],
      tools: [],
      maximumOutputTokens: resolved.contextProfile.maximumOutputTokens,
      signal: new AbortController().signal,
    }),
  );

  expect({ identity: resolved.identity, requests, events }).toEqual({
    identity: {
      targetId: "deepseek-v4-flash.direct",
      vendor: "deepseek",
      modelId: "deepseek-v4-flash",
      route: "direct",
      profileVersion: 3,
      certification: "certified",
    },
    requests: [
      {
        url: "https://api.deepseek.com/chat/completions",
        body: expect.objectContaining({
          model: "deepseek-v4-flash",
          messages: [{ role: "user", content: "Introduce yourself" }],
          max_tokens: 384_000,
          stream: true,
        }),
      },
    ],
    events: [
      { type: "text_delta", text: "Hello, Adam." },
      { type: "usage", inputTokens: 7, outputTokens: 3 },
      { type: "finish", reason: "stop", rawReason: "stop" },
    ],
  });
});

test("the exact Vision Chat target projects immutable PNG bytes through Direct Chat", async () => {
  const requests: Array<{ readonly url: string; readonly body: unknown }> = [];
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async (input, init) => {
      requests.push({
        url: input instanceof Request ? input.url : String(input),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  });
  const resolved = await targets.resolve({
    targetId: "deepseek-v4-flash-vision-exp.direct",
    allowExperimental: false,
    signal: new AbortController().signal,
  });
  const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

  const events = await collect(
    resolved.driver.stream({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image." },
            {
              type: "file",
              artifactId: `sha256:${"a".repeat(64)}`,
              mediaType: "image/png",
              bytes: imageBytes,
            },
          ],
        },
      ],
      tools: [],
      maximumOutputTokens: resolved.contextProfile.maximumOutputTokens,
      signal: new AbortController().signal,
    }),
  );

  expect({
    identity: resolved.identity,
    modalityProfile: resolved.modalityProfile,
    requests,
    events,
  }).toEqual({
    identity: {
      targetId: "deepseek-v4-flash-vision-exp.direct",
      vendor: "deepseek",
      modelId: "deepseek-v4-flash-vision-exp",
      route: "direct",
      profileVersion: 1,
      certification: "certified",
    },
    modalityProfile: {
      profileVersion: 1,
      explicitUserImages: "supported",
      imageToolResults: "unsupported",
    },
    requests: [
      {
        url: "https://api.deepseek.com/chat/completions",
        body: expect.objectContaining({
          model: "deepseek-v4-flash-vision-exp",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Describe this image." },
                {
                  type: "image_url",
                  image_url: { url: "data:image/png;base64,iVBORw==" },
                },
              ],
            },
          ],
          max_tokens: 384_000,
          stream: true,
        }),
      },
    ],
    events: [
      { type: "text_delta", text: "Hello, Adam." },
      { type: "usage", inputTokens: 7, outputTokens: 3 },
      { type: "finish", reason: "stop", rawReason: "stop" },
    ],
  });
});

test("the exact Vision Chat target classifies a provider error for structured image input", async () => {
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-secret-key" },
    fetch: async () =>
      Response.json(
        {
          error: {
            message: "Insufficient balance for test-secret-key",
            type: "insufficient_balance",
            code: "billing_error",
          },
        },
        { status: 402 },
      ),
  });
  const { driver } = await targets.resolve({
    targetId: "deepseek-v4-flash-vision-exp.direct",
    allowExperimental: false,
    signal: new AbortController().signal,
  });

  const error = await collectError(
    driver.stream({
      maximumOutputTokens: 4_096,
      messages: [visionImageMessage()],
      tools: [],
      signal: new AbortController().signal,
    }),
  );

  expect(error).toMatchObject({
    category: "billing",
    status: 402,
    providerCode: "billing_error",
    responseSummary: "Insufficient balance for [REDACTED]",
  });
});

test("the exact Vision Chat target preserves cancellation during structured image input", async () => {
  const requestStarted = Promise.withResolvers<AbortSignal>();
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async (_input, init) => {
      const signal = init?.signal;
      if (signal === null || signal === undefined) {
        throw new Error("Expected the Vision Chat request signal.");
      }
      requestStarted.resolve(signal);
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  const { driver } = await targets.resolve({
    targetId: "deepseek-v4-flash-vision-exp.direct",
    allowExperimental: false,
    signal: new AbortController().signal,
  });
  const controller = new AbortController();
  const error = collectError(
    driver.stream({
      maximumOutputTokens: 4_096,
      messages: [visionImageMessage()],
      tools: [],
      signal: controller.signal,
    }),
  );
  const requestSignal = await requestStarted.promise;

  controller.abort(new DOMException("Vision request cancelled.", "AbortError"));

  await expect(error).resolves.toMatchObject({
    category: "aborted",
    message: "The model provider request was aborted.",
  });
  expect(requestSignal.aborted).toBe(true);
});

test("the explicit Direct connection test authenticates one bounded models handshake", async () => {
  const requests: Array<{
    readonly url: string;
    readonly method: string | undefined;
    readonly authorization: string | null;
  }> = [];
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async (input, init) => {
      requests.push({
        url: input instanceof Request ? input.url : String(input),
        method: init?.method,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({
        object: "list",
        data: [{ id: "deepseek-v4-flash-vision-exp", object: "model", owned_by: "deepseek" }],
      });
    },
  });
  if (targets.testConnection === undefined) {
    throw new Error("Expected the production model-target connection test.");
  }

  await expect(
    targets.testConnection({
      targetId: "deepseek-v4-flash-vision-exp.direct",
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual({ status: "reachable", diagnostic: null });
  expect(requests).toEqual([
    {
      url: "https://api.deepseek.com/models",
      method: "GET",
      authorization: "Bearer test-deepseek-key",
    },
  ]);
});

test("the explicit Direct connection test propagates caller cancellation to its one request", async () => {
  const requestStarted = Promise.withResolvers<AbortSignal>();
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async (_input, init) => {
      const signal = init?.signal;
      if (signal === null || signal === undefined) {
        throw new Error("Expected the connection request signal.");
      }
      requestStarted.resolve(signal);
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  if (targets.testConnection === undefined) {
    throw new Error("Expected the production model-target connection test.");
  }
  const controller = new AbortController();
  const cancellation = new DOMException("Caller cancelled the connection test.", "AbortError");
  const result = targets.testConnection({
    targetId: "deepseek-v4-flash-vision-exp.direct",
    signal: controller.signal,
  });
  const requestSignal = await requestStarted.promise;

  controller.abort(cancellation);

  await expect(result).rejects.toBe(cancellation);
  expect(requestSignal.aborted).toBe(true);
  expect(requestSignal.reason).toBe(cancellation);
});

test("the explicit Direct connection test settles a causally expired request as unreachable", async () => {
  vi.useFakeTimers();
  try {
    const requestStarted = Promise.withResolvers<AbortSignal>();
    const targets = createModelTargets({
      environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
      connectionDeadlineMs: 25,
      fetch: async (_input, init) => {
        const signal = init?.signal;
        if (signal === null || signal === undefined) {
          throw new Error("Expected the connection request signal.");
        }
        requestStarted.resolve(signal);
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    if (targets.testConnection === undefined) {
      throw new Error("Expected the production model-target connection test.");
    }
    const result = targets.testConnection({
      targetId: "deepseek-v4-flash-vision-exp.direct",
      signal: new AbortController().signal,
    });
    const requestSignal = await requestStarted.promise;

    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toEqual({
      status: "unreachable",
      diagnostic: {
        code: "connection_timeout",
        message: "The authenticated model catalog request reached its deadline.",
      },
    });
    expect(requestSignal.aborted).toBe(true);
    expect(requestSignal.reason).toMatchObject({ name: "TimeoutError" });
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  {
    name: "an HTTP rejection",
    response: () => Response.json({ error: "unauthorized" }, { status: 401 }),
    diagnostic: {
      code: "connection_http_error",
      message: "The authenticated model catalog returned HTTP 401.",
    },
  },
  {
    name: "a missing exact model",
    response: () => Response.json({ object: "list", data: [{ id: "another-model" }] }),
    diagnostic: {
      code: "connection_model_not_advertised",
      message: "The authenticated model catalog did not advertise the expected exact model.",
    },
  },
  {
    name: "an oversized response",
    response: () => new Response("x".repeat(256 * 1024 + 1)),
    diagnostic: {
      code: "connection_response_too_large",
      message: "The authenticated model catalog exceeded Adam's response limit.",
    },
  },
  {
    name: "too many advertised models",
    response: () =>
      Response.json({
        object: "list",
        data: Array.from({ length: 4_097 }, (_, index) => ({ id: `model-${index}` })),
      }),
    diagnostic: {
      code: "connection_response_invalid",
      message: "The authenticated model catalog response is invalid.",
    },
  },
])("the explicit Direct connection test bounds $name", async ({ response, diagnostic }) => {
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () => response(),
  });
  if (targets.testConnection === undefined) {
    throw new Error("Expected the production model-target connection test.");
  }

  await expect(
    targets.testConnection({
      targetId: "deepseek-v4-flash-vision-exp.direct",
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual({ status: "unreachable", diagnostic });
});

test("an exact Direct DeepSeek target exposes only its real thinking policy choices", async () => {
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
  });

  const snapshot = await targets.snapshot({
    signal: new AbortController().signal,
  });
  const target = snapshot.targets.find(
    (candidate) => candidate.identity.targetId === "deepseek-v4-flash.direct",
  );
  if (target?.thinkingCapability === undefined) {
    throw new Error("Expected the exact Direct DeepSeek thinking capability.");
  }

  expect(target.thinkingCapability).toMatchObject({
    schemaVersion: 1,
    capabilityId: "deepseek-chat-thinking:deepseek-v4-flash.direct:target-profile-3",
    capabilityVersion: 1,
    targetIdentity: target.identity,
    providerProfile: {
      id: "@ai-sdk/deepseek/chat",
      version: "3.0.30",
      requestPath: "provider_options.deepseek",
    },
    supportsOff: true,
    defaultLevelId: "high",
    providerDefault: { effectiveLevelId: "high", mutable: true },
    levels: [
      { id: "off", label: "Off", effectiveLevelId: "off" },
      { id: "low", label: "Low", effectiveLevelId: "low" },
      { id: "high", label: "High", effectiveLevelId: "high" },
      { id: "max", label: "Max", effectiveLevelId: "max" },
    ],
    reasoningArtifact: "provider_reasoning",
    capabilityDigest: "sha256:0af69c6828ddc0f68e6ae38c0203c855288df76ac56c2431b4570b96b7603287",
  });
  expect(target.thinkingCapability.levels.map((level) => level.id)).not.toEqual(
    expect.arrayContaining(["medium", "xhigh"]),
  );

  expect(resolveThinkingPolicy(target.thinkingCapability, "max")).toEqual({
    schemaVersion: 1,
    requestedLevelId: "max",
    effectiveLevelId: "max",
    capability: {
      id: target.thinkingCapability.capabilityId,
      version: 1,
      digest: target.thinkingCapability.capabilityDigest,
    },
    mapping: {
      requestPath: "provider_options.deepseek",
      thinkingType: "enabled",
      reasoningEffort: "max",
    },
    reasoningArtifact: "provider_reasoning",
  });
});

test.each([
  {
    levelId: "off",
    expected: { thinking: { type: "disabled" } },
    unexpectedEffort: true,
  },
  {
    levelId: "low",
    expected: { thinking: { type: "enabled" }, reasoning_effort: "low" },
    unexpectedEffort: false,
  },
  {
    levelId: "high",
    expected: { thinking: { type: "enabled" }, reasoning_effort: "high" },
    unexpectedEffort: false,
  },
  {
    levelId: "max",
    expected: { thinking: { type: "enabled" }, reasoning_effort: "max" },
    unexpectedEffort: false,
  },
] as const)(
  "the Direct DeepSeek $levelId policy uses the exact provider-specific request path",
  async ({ levelId, expected, unexpectedEffort }) => {
    const requests: unknown[] = [];
    const targets = createModelTargets({
      environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
      fetch: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(answerOnlyDeepSeekStream, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        });
      },
    });
    const resolved = await targets.resolve({
      targetId: "deepseek-v4-flash.direct",
      allowExperimental: false,
      signal: new AbortController().signal,
    });
    if (resolved.thinkingCapability === undefined) {
      throw new Error("Expected the exact Direct DeepSeek thinking capability.");
    }

    await collect(
      resolved.driver.stream({
        messages: [{ role: "user", content: "Answer with the selected policy." }],
        tools: [],
        maximumOutputTokens: 4_096,
        signal: new AbortController().signal,
        thinkingPolicy: resolveThinkingPolicy(resolved.thinkingCapability, levelId),
      }),
    );

    expect(requests).toEqual([expect.objectContaining(expected)]);
    expect((requests[0] as { reasoning?: unknown }).reasoning).toBeUndefined();
    if (unexpectedEffort) {
      expect((requests[0] as { reasoning_effort?: unknown }).reasoning_effort).toBeUndefined();
    }
  },
);

test.each([
  {
    purpose: "title",
    expected: { thinking: { type: "disabled" } },
  },
  {
    purpose: "compaction",
    expected: { thinking: { type: "enabled" }, reasoning_effort: "high" },
  },
] as const)(
  "the Direct DeepSeek $purpose side call uses its code-owned thinking policy",
  async ({ purpose, expected }) => {
    const requests: unknown[] = [];
    const targets = createModelTargets({
      environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
      fetch: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(answerOnlyDeepSeekStream, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        });
      },
    });
    const resolved = await targets.resolve({
      targetId: "deepseek-v4-flash.direct",
      allowExperimental: false,
      signal: new AbortController().signal,
    });
    if (resolved.thinkingCapability === undefined) {
      throw new Error("Expected the exact Direct DeepSeek thinking capability.");
    }

    await collect(
      resolved.driver.stream({
        messages: [{ role: "user", content: "Perform one bounded side call." }],
        tools: [],
        maximumOutputTokens: 4_096,
        purpose,
        signal: new AbortController().signal,
        thinkingPolicy: resolveThinkingPolicy(resolved.thinkingCapability, "max"),
      }),
    );

    expect(requests).toEqual([expect.objectContaining(expected)]);
  },
);

test("the unified driver preserves DeepSeek reasoning and cache usage details", async () => {
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () =>
      new Response(detailedUsageDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
  });
  const { driver } = await targets.resolve({
    targetId: "deepseek-v4-pro.direct",
    allowExperimental: false,
    signal: new AbortController().signal,
  });

  const events = await collect(
    driver.stream({
      maximumOutputTokens: 4_096,
      messages: [{ role: "user", content: "Answer" }],
      tools: [],
      signal: new AbortController().signal,
    }),
  );

  expect(events).toContainEqual({
    type: "usage",
    inputTokens: 7,
    outputTokens: 3,
    reasoningTokens: 1,
    cachedInputTokens: 2,
    cacheMissInputTokens: 5,
  });
});

test.each([
  { raw: "length", reason: "length" },
  { raw: "content_filter", reason: "content_filter" },
  { raw: "insufficient_system_resource", reason: "resource_exhausted" },
  { raw: "future_reason", reason: "unknown" },
] as const)("the unified driver maps DeepSeek $raw finish truth", async ({ raw, reason }) => {
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () =>
      new Response(finishReasonDeepSeekStream(raw), {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
  });
  const { driver } = await targets.resolve({
    targetId: "deepseek-v4-pro.direct",
    allowExperimental: false,
    signal: new AbortController().signal,
  });

  const events = await collect(
    driver.stream({
      maximumOutputTokens: 4_096,
      messages: [{ role: "user", content: "Answer" }],
      tools: [],
      signal: new AbortController().signal,
    }),
  );

  expect(events.at(-1)).toEqual({ type: "finish", reason, rawReason: raw });
});

test("the unified driver preserves reasoning and fragmented tool calls for Adam to execute", async () => {
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () =>
      new Response(reasoningToolDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
  });
  const { driver } = await targets.resolve({
    targetId: "deepseek-v4-pro.direct",
    allowExperimental: false,
    signal: new AbortController().signal,
  });

  const events = await collect(
    driver.stream({
      maximumOutputTokens: 4_096,
      messages: [{ role: "user", content: "Read the project name" }],
      tools: [
        {
          name: "read_file",
          description: "Read a UTF-8 text file inside the workspace.",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      ],
      signal: new AbortController().signal,
    }),
  );

  expect(events).toEqual([
    { type: "reasoning_start", id: "provider-reasoning-0", artifactType: "provider_reasoning" },
    { type: "reasoning_delta", id: "provider-reasoning-0", text: "I need " },
    { type: "reasoning_delta", id: "provider-reasoning-0", text: "the README." },
    { type: "tool_call_start", id: "read-project", name: "read_file" },
    { type: "tool_call_delta", id: "read-project", json: '{"pa' },
    { type: "tool_call_delta", id: "read-project", json: 'th":"README.md"}' },
    { type: "tool_call_end", id: "read-project" },
    { type: "reasoning_end", id: "provider-reasoning-0" },
    { type: "usage", inputTokens: 13, outputTokens: 9 },
    { type: "finish", reason: "tool_calls", rawReason: "tool_calls" },
  ]);
});

test("the unified driver preserves multiple interleaved non-reasoning tool calls", async () => {
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () =>
      new Response(multipleToolDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
  });
  const { driver } = await targets.resolve({
    targetId: "deepseek-v4-pro.direct",
    allowExperimental: false,
    signal: new AbortController().signal,
  });

  const events = await collect(
    driver.stream({
      maximumOutputTokens: 4_096,
      messages: [{ role: "user", content: "Read two files" }],
      tools: [readFileDefinition],
      signal: new AbortController().signal,
    }),
  );

  expect(events).toEqual([
    { type: "tool_call_start", id: "read-a", name: "read_file" },
    { type: "tool_call_delta", id: "read-a", json: '{"path":"a' },
    { type: "tool_call_start", id: "read-b", name: "read_file" },
    { type: "tool_call_delta", id: "read-b", json: '{"path":"b' },
    { type: "tool_call_delta", id: "read-a", json: '.txt"}' },
    { type: "tool_call_delta", id: "read-b", json: '.txt"}' },
    { type: "tool_call_end", id: "read-a" },
    { type: "tool_call_end", id: "read-b" },
    { type: "usage", inputTokens: 9, outputTokens: 8 },
    { type: "finish", reason: "tool_calls", rawReason: "tool_calls" },
  ]);
});

test.each(["deepseek-v4-flash", "deepseek-v4-pro"] as const)(
  "the exact %s unified target matches the Direct reasoning-tool contract",
  async (modelId) => {
    const createFixtureResponse = () =>
      new Response(reasoningToolDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    const direct = new OpenAICompatibleModelDriver({
      profile: "deepseek",
      apiKey: "test-deepseek-key",
      baseURL: "https://api.deepseek.com",
      model: modelId,
      maximumOutputTokens: 32_768,
      fetch: async () => createFixtureResponse(),
    });
    const targets = createModelTargets({
      environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
      fetch: async () => createFixtureResponse(),
    });
    const { driver: unified } = await targets.resolve({
      targetId: `${modelId}.direct`,
      allowExperimental: false,
      signal: new AbortController().signal,
    });
    const request = () => ({
      messages: [{ role: "user" as const, content: "Read the project name" }],
      tools: [readFileDefinition],
      maximumOutputTokens: 4_096,
      signal: new AbortController().signal,
    });

    expect(await collect(unified.stream(request()))).toEqual(
      await collect(direct.stream(request())),
    );
  },
);

test.each([
  {
    label: "Flash",
    targetId: "deepseek-v4-flash.direct",
    modelId: "deepseek-v4-flash",
    capabilityId: "deepseek-chat-thinking:deepseek-v4-flash.direct:target-profile-2",
    v2Digest: "sha256:81aa965c6378ee4995f6e7e1dab30e6086ab0508ced7b55b4b63a3dd5da913a8",
    v1Digest: "sha256:66929505ba3695e601c820a2bb1213c2959045813f5f91a74755622b3032c31f",
  },
  {
    label: "Pro",
    targetId: "deepseek-v4-pro.direct",
    modelId: "deepseek-v4-pro",
    capabilityId: "deepseek-chat-thinking:deepseek-v4-pro.direct:target-profile-2",
    v2Digest: "sha256:ab5c6d78a323ef6092af2a09dfd83c2d098e14fb02eaa50606e3f25e867771f0",
    v1Digest: "sha256:a2ffdfea3729204de7a348287e0e2bb43c949f88881433ab9e77210da326ba5a",
  },
] as const)(
  "the historical Direct DeepSeek $label v2 capability and reasoning-tool contract remain fixed",
  async ({ targetId, modelId, capabilityId, v2Digest, v1Digest }) => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-deepseek-v2-characterization-"));
    await writeFile(join(workspaceRoot, "README.md"), "# Adam Agent\n", "utf8");
    const requests: unknown[] = [];
    let requestCount = 0;
    const targets = createModelTargets({
      environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
      fetch: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        requestCount += 1;
        return new Response(
          requestCount === 1 ? reasoningToolDeepSeekStream : finalAnswerDeepSeekStream,
          { headers: { "content-type": "text/event-stream" }, status: 200 },
        );
      },
    });
    const historicalV2Identity: ModelTargetIdentity = {
      targetId,
      vendor: "deepseek",
      modelId,
      route: "direct",
      profileVersion: 2,
      certification: "certified",
    };
    const resolved = await targets.resolve({
      targetId,
      targetIdentity: historicalV2Identity,
      allowExperimental: false,
      signal: new AbortController().signal,
    });
    const historicalV1 = await targets.resolve({
      targetId,
      targetIdentity: { ...historicalV2Identity, profileVersion: 1 },
      allowExperimental: false,
      signal: new AbortController().signal,
    });
    const events: RuntimeEvent[] = [];
    const session = new AgentSession({
      maximumOutputTokens: resolved.contextProfile.maximumOutputTokens,
      model: resolved.driver,
      tools: createReadToolRegistry({ workspaceRoot }),
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      store: createInMemorySessionStore(),
    });
    session.subscribe((event) => events.push(event));

    try {
      await expect(session.run({ text: "Read the project name" })).resolves.toEqual({
        status: "completed",
        answer: "The project is Adam Agent.",
      });
      expect(resolved.thinkingCapability).toEqual({
        schemaVersion: 1,
        capabilityId,
        capabilityVersion: 1,
        capabilityDigest: v2Digest,
        targetIdentity: historicalV2Identity,
        providerProfile: {
          id: "@ai-sdk/deepseek/chat",
          version: "3.0.28",
          requestPath: "provider_options.deepseek",
        },
        supportsOff: true,
        defaultLevelId: "high",
        providerDefault: { effectiveLevelId: "high", mutable: true },
        levels: [
          {
            id: "off",
            label: "Off",
            effectiveLevelId: "off",
            mapping: {
              requestPath: "provider_options.deepseek",
              thinkingType: "disabled",
            },
          },
          {
            id: "low",
            label: "Low",
            effectiveLevelId: "low",
            mapping: {
              requestPath: "provider_options.deepseek",
              thinkingType: "enabled",
              reasoningEffort: "low",
            },
          },
          {
            id: "high",
            label: "High",
            effectiveLevelId: "high",
            mapping: {
              requestPath: "provider_options.deepseek",
              thinkingType: "enabled",
              reasoningEffort: "high",
            },
          },
          {
            id: "max",
            label: "Max",
            effectiveLevelId: "max",
            mapping: {
              requestPath: "provider_options.deepseek",
              thinkingType: "enabled",
              reasoningEffort: "max",
            },
          },
        ],
        reasoningArtifact: "provider_reasoning",
      });
      expect(historicalV1.thinkingCapability).toMatchObject({
        capabilityDigest: v1Digest,
        providerProfile: { id: "@ai-sdk/deepseek/chat", version: "3.0.28" },
        targetIdentity: { ...historicalV2Identity, profileVersion: 1 },
      });
      expect(requests).toEqual([
        expect.objectContaining({
          model: modelId,
          max_tokens: 384_000,
          messages: expect.arrayContaining([{ role: "user", content: "Read the project name" }]),
        }),
        expect.objectContaining({
          model: modelId,
          max_tokens: 384_000,
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: "assistant",
              reasoning_content: "I need the README.",
            }),
            {
              role: "tool",
              tool_call_id: "read-project",
              content:
                '{"status":"completed","output":{"path":"README.md","content":"# Adam Agent\\n","truncated":false}}',
            },
          ]),
        }),
      ]);
      expect(events).toContainEqual({
        type: "tool_completed",
        callId: "read-project",
        name: "read_file",
        output: { path: "README.md", content: "# Adam Agent\n", truncated: false },
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  },
);

test("AgentSession uses current Direct DeepSeek Flash v3 while historical profiles remain exact", async () => {
  const requests: unknown[] = [];
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  });
  const current = await targets.resolve({
    targetId: "deepseek-v4-flash.direct",
    allowExperimental: false,
    signal: new AbortController().signal,
  });
  const historicalV2 = await targets.resolve({
    targetId: "deepseek-v4-flash.direct",
    targetIdentity: { ...current.identity, profileVersion: 2 },
    allowExperimental: false,
    signal: new AbortController().signal,
  });
  const historicalV1 = await targets.resolve({
    targetId: "deepseek-v4-flash.direct",
    targetIdentity: { ...current.identity, profileVersion: 1 },
    allowExperimental: false,
    signal: new AbortController().signal,
  });
  const session = new AgentSession({
    maximumOutputTokens: current.contextProfile.maximumOutputTokens,
    model: current.driver,
    store: createInMemorySessionStore(),
  });

  await expect(session.run({ text: "Introduce yourself" })).resolves.toEqual({
    status: "completed",
    answer: "Hello, Adam.",
  });
  expect(current).toMatchObject({
    identity: { profileVersion: 3 },
    contextProfile: { version: 2, maximumOutputTokens: 384_000 },
    thinkingCapability: {
      capabilityId: "deepseek-chat-thinking:deepseek-v4-flash.direct:target-profile-3",
      providerProfile: { id: "@ai-sdk/deepseek/chat", version: "3.0.30" },
    },
  });
  expect(historicalV2).toMatchObject({
    identity: { profileVersion: 2 },
    contextProfile: { version: 2, maximumOutputTokens: 384_000 },
    thinkingCapability: {
      capabilityId: "deepseek-chat-thinking:deepseek-v4-flash.direct:target-profile-2",
      capabilityDigest: "sha256:81aa965c6378ee4995f6e7e1dab30e6086ab0508ced7b55b4b63a3dd5da913a8",
      providerProfile: { id: "@ai-sdk/deepseek/chat", version: "3.0.28" },
    },
  });
  expect(historicalV1).toMatchObject({
    identity: { profileVersion: 1 },
    contextProfile: { version: 1, maximumOutputTokens: 32_768 },
    thinkingCapability: {
      capabilityId: "deepseek-chat-thinking:deepseek-v4-flash.direct:target-profile-1",
      capabilityDigest: "sha256:66929505ba3695e601c820a2bb1213c2959045813f5f91a74755622b3032c31f",
      providerProfile: { id: "@ai-sdk/deepseek/chat", version: "3.0.28" },
    },
  });
  expect(requests).toEqual([
    expect.objectContaining({
      model: "deepseek-v4-flash",
      max_tokens: 384_000,
      messages: expect.arrayContaining([{ role: "user", content: "Introduce yourself" }]),
    }),
  ]);
});

test("AgentSession keeps tool execution and replay state while using the unified driver", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-model-target-"));
  await writeFile(join(workspaceRoot, "README.md"), "# Adam Agent\n", "utf8");
  const requests: unknown[] = [];
  let requestCount = 0;
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      requestCount += 1;
      return new Response(
        requestCount === 1 ? reasoningToolDeepSeekStream : finalAnswerDeepSeekStream,
        { headers: { "content-type": "text/event-stream" }, status: 200 },
      );
    },
  });
  const resolved = await targets.resolve({
    targetId: "deepseek-v4-pro.direct",
    allowExperimental: false,
    signal: new AbortController().signal,
  });
  const { driver } = resolved;
  const store = createInMemorySessionStore();
  const session = new AgentSession({
    maximumOutputTokens: 32_768,
    model: driver,
    tools: createReadToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    store,
  });
  const events: RuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));

  try {
    const result = await session.run({ text: "Read the project name" });

    expect({ result, requestCount }).toEqual({
      result: { status: "completed", answer: "The project is Adam Agent." },
      requestCount: 2,
    });
    expect(resolved).toMatchObject({
      identity: { profileVersion: 3 },
      contextProfile: { version: 2, maximumOutputTokens: 384_000 },
      thinkingCapability: {
        capabilityId: "deepseek-chat-thinking:deepseek-v4-pro.direct:target-profile-3",
        capabilityDigest: "sha256:5deb10622dcda4511c80faa9bb8920fe0750f67c4b63c18b4bf75975bb4fa5f2",
        providerProfile: { id: "@ai-sdk/deepseek/chat", version: "3.0.30" },
      },
    });
    expect(events).toContainEqual({
      type: "tool_completed",
      callId: "read-project",
      name: "read_file",
      output: { path: "README.md", content: "# Adam Agent\n", truncated: false },
    });
    expect(requests.map((request) => (request as { max_tokens?: number }).max_tokens)).toEqual([
      32_768, 32_768,
    ]);
    expect(requests[1]).toEqual(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            reasoning_content: "I need the README.",
          }),
          expect.objectContaining({
            role: "tool",
            tool_call_id: "read-project",
            content:
              '{"status":"completed","output":{"path":"README.md","content":"# Adam Agent\\n","truncated":false}}',
          }),
        ]),
      }),
    );
    expect(JSON.stringify(await store.read())).not.toContain("I need the README.");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("the V4 profile lowers developer instructions and backfills empty reasoning in tool history", async () => {
  const requests: unknown[] = [];
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  });
  const { driver } = await targets.resolve({
    targetId: "deepseek-v4-pro.direct",
    allowExperimental: false,
    signal: new AbortController().signal,
  });

  await collect(
    driver.stream({
      maximumOutputTokens: 4_096,
      messages: [
        { role: "system", content: "Follow the platform rules." },
        { role: "developer", content: "Work only inside the repository." },
        { role: "user", content: "Read the project name." },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "read-project", name: "read_file", argumentsJson: '{"path":"README.md"}' },
          ],
        },
        {
          role: "tool",
          callId: "read-project",
          name: "read_file",
          result: {
            status: "completed",
            output: { path: "README.md", content: "# Adam Agent\n", truncated: false },
          },
        },
      ],
      tools: [],
      signal: new AbortController().signal,
    }),
  );

  expect(requests).toEqual([
    expect.objectContaining({
      messages: [
        { role: "system", content: "Follow the platform rules." },
        {
          role: "system",
          content: "Developer instruction:\nWork only inside the repository.",
        },
        { role: "user", content: "Read the project name." },
        {
          role: "assistant",
          content: "",
          reasoning_content: "",
          tool_calls: [
            {
              id: "read-project",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"README.md"}' },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "read-project",
          content:
            '{"status":"completed","output":{"path":"README.md","content":"# Adam Agent\\n","truncated":false}}',
        },
      ],
    }),
  ]);
});

test("the unified driver classifies DeepSeek HTTP 402 without retaining credential text", async () => {
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-secret-key" },
    fetch: async () =>
      Response.json(
        {
          error: {
            message: "Insufficient balance for test-secret-key",
            type: "insufficient_balance",
            code: "billing_error",
          },
        },
        { status: 402, headers: { "x-request-id": "request-test-secret-key" } },
      ),
  });
  const { driver } = await targets.resolve({
    targetId: "deepseek-v4-pro.direct",
    allowExperimental: false,
    signal: new AbortController().signal,
  });

  const error = await collectError(
    driver.stream({
      maximumOutputTokens: 4_096,
      messages: [{ role: "user", content: "Answer" }],
      tools: [],
      signal: new AbortController().signal,
    }),
  );

  expect(error).toMatchObject({
    category: "billing",
    status: 402,
    providerCode: "billing_error",
    requestId: "request-[REDACTED]",
    responseSummary: "Insufficient balance for [REDACTED]",
  });
});

test("the unified driver classifies documented DeepSeek HTTP 422 as an invalid request", async () => {
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () =>
      Response.json(
        {
          error: {
            message: "The request parameters are invalid.",
            type: "invalid_request_error",
            code: "invalid_parameters",
          },
        },
        { status: 422 },
      ),
  });
  const { driver } = await targets.resolve({
    targetId: "deepseek-v4-pro.direct",
    allowExperimental: false,
    signal: new AbortController().signal,
  });

  const error = await collectError(
    driver.stream({
      maximumOutputTokens: 4_096,
      messages: [{ role: "user", content: "Answer" }],
      tools: [],
      signal: new AbortController().signal,
    }),
  );

  expect(error).toMatchObject({
    category: "invalid_request",
    status: 422,
    providerCode: "invalid_parameters",
    responseSummary: "The request parameters are invalid.",
  });
});

test("the unified driver preserves caller cancellation while a provider request is active", async () => {
  let reportStarted = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    reportStarted = resolve;
  });
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async (_input, init) => {
      reportStarted();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("The request was aborted.", "AbortError")),
          { once: true },
        );
      });
    },
  });
  const { driver } = await targets.resolve({
    targetId: "deepseek-v4-pro.direct",
    allowExperimental: false,
    signal: new AbortController().signal,
  });
  const controller = new AbortController();

  const errorPromise = collectError(
    driver.stream({
      maximumOutputTokens: 4_096,
      messages: [{ role: "user", content: "Answer" }],
      tools: [],
      signal: controller.signal,
    }),
  );
  await started;
  controller.abort(new Error("caller cancelled"));

  await expect(errorPromise).resolves.toMatchObject({
    category: "aborted",
    message: "The model provider request was aborted.",
  });
});

test("the unified driver enforces the first-response deadline", async () => {
  vi.useFakeTimers();
  try {
    let reportStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    const targets = createModelTargets({
      environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
      deadlineMs: 1_000,
      fetch: async (_input, init) => {
        reportStarted();
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The request reached its deadline.", "AbortError")),
            { once: true },
          );
        });
      },
    });
    const { driver } = await targets.resolve({
      targetId: "deepseek-v4-pro.direct",
      allowExperimental: false,
      signal: new AbortController().signal,
    });

    const errorPromise = collectError(
      driver.stream({
        maximumOutputTokens: 4_096,
        messages: [{ role: "user", content: "Answer" }],
        tools: [],
        signal: new AbortController().signal,
      }),
    );
    await started;
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(errorPromise).resolves.toMatchObject({
      category: "timeout",
      message: "The model provider request reached its deadline.",
    });
  } finally {
    vi.useRealTimers();
  }
});

test("the unified driver resets inactivity only after accepted non-empty progress", async () => {
  vi.useFakeTimers();
  try {
    let streamController: ReadableStreamDefaultController<unknown> | undefined;
    let reportStreamReady = (): void => undefined;
    const streamReady = new Promise<void>((resolve) => {
      reportStreamReady = resolve;
    });
    const model = {
      specificationVersion: "v4",
      provider: "test",
      modelId: "progress-timeout",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("Generation is not used by this test.");
      },
      async doStream(options: { readonly abortSignal?: AbortSignal }) {
        return {
          stream: new ReadableStream({
            start(controller) {
              streamController = controller;
              options.abortSignal?.addEventListener(
                "abort",
                () => controller.error(options.abortSignal?.reason),
                { once: true },
              );
              reportStreamReady();
            },
          }),
        };
      },
    } as unknown as ConstructorParameters<typeof AiSdkModelDriverForTesting>[0]["model"];
    const driver = new AiSdkModelDriverForTesting({
      model,
      maximumOutputTokens: 4_096,
      deadlineMs: 1_000,
      sensitiveValues: [],
    });
    const iterator = driver
      .stream({
        maximumOutputTokens: 4_096,
        messages: [{ role: "user", content: "Keep progressing." }],
        tools: [],
        signal: new AbortController().signal,
      })
      [Symbol.asyncIterator]();
    const firstEvent = iterator.next();
    await streamReady;
    await vi.advanceTimersByTimeAsync(900);
    streamController?.enqueue({ type: "text-delta", id: "text-0", delta: "a" });
    await expect(firstEvent).resolves.toEqual({
      done: false,
      value: { type: "text_delta", text: "a" },
    });

    const completion = iterator.next();
    await vi.advanceTimersByTimeAsync(900);
    streamController?.close();
    await expect(completion).resolves.toEqual({ done: true, value: undefined });
  } finally {
    vi.useRealTimers();
  }
});

test("the unified driver does not reset inactivity for metadata or empty deltas", async () => {
  vi.useFakeTimers();
  try {
    let streamController: ReadableStreamDefaultController<unknown> | undefined;
    let reportStreamReady = (): void => undefined;
    const streamReady = new Promise<void>((resolve) => {
      reportStreamReady = resolve;
    });
    const model = {
      specificationVersion: "v4",
      provider: "test",
      modelId: "non-progress-timeout",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("Generation is not used by this test.");
      },
      async doStream(options: { readonly abortSignal?: AbortSignal }) {
        return {
          stream: new ReadableStream({
            start(controller) {
              streamController = controller;
              options.abortSignal?.addEventListener(
                "abort",
                () => controller.error(options.abortSignal?.reason),
                { once: true },
              );
              reportStreamReady();
            },
          }),
        };
      },
    } as unknown as ConstructorParameters<typeof AiSdkModelDriverForTesting>[0]["model"];
    const driver = new AiSdkModelDriverForTesting({
      model,
      maximumOutputTokens: 4_096,
      deadlineMs: 1_000,
      sensitiveValues: [],
    });
    const iterator = driver
      .stream({
        maximumOutputTokens: 4_096,
        messages: [{ role: "user", content: "Ignore non-progress." }],
        tools: [],
        signal: new AbortController().signal,
      })
      [Symbol.asyncIterator]();
    const emptyEvent = iterator.next();
    await streamReady;
    await vi.advanceTimersByTimeAsync(900);
    streamController?.enqueue({ type: "response-metadata" });
    await vi.advanceTimersByTimeAsync(50);
    streamController?.enqueue({ type: "text-delta", id: "text-0", delta: "" });
    await expect(emptyEvent).resolves.toEqual({
      done: false,
      value: { type: "text_delta", text: "" },
    });

    const timeout = iterator.next();
    const timeoutExpectation = expect(timeout).rejects.toMatchObject({ category: "timeout" });
    await vi.advanceTimersByTimeAsync(50);
    await timeoutExpectation;
  } finally {
    vi.useRealTimers();
  }
});

test("valid tool-state transitions keep a long provider stream alive", async () => {
  vi.useFakeTimers();
  try {
    let streamController: ReadableStreamDefaultController<unknown> | undefined;
    let reportStreamReady = (): void => undefined;
    const streamReady = new Promise<void>((resolve) => {
      reportStreamReady = resolve;
    });
    const model = {
      specificationVersion: "v4",
      provider: "test",
      modelId: "tool-progress-timeout",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("Generation is not used by this test.");
      },
      async doStream(options: { readonly abortSignal?: AbortSignal }) {
        return {
          stream: new ReadableStream({
            start(controller) {
              streamController = controller;
              options.abortSignal?.addEventListener(
                "abort",
                () => controller.error(options.abortSignal?.reason),
                { once: true },
              );
              reportStreamReady();
            },
          }),
        };
      },
    } as unknown as ConstructorParameters<typeof AiSdkModelDriverForTesting>[0]["model"];
    const driver = new AiSdkModelDriverForTesting({
      model,
      maximumOutputTokens: 4_096,
      deadlineMs: 1_000,
      sensitiveValues: [],
    });
    const iterator = driver
      .stream({
        maximumOutputTokens: 4_096,
        messages: [{ role: "user", content: "Call a tool slowly." }],
        tools: [],
        signal: new AbortController().signal,
      })
      [Symbol.asyncIterator]();
    const started = iterator.next();
    await streamReady;
    await vi.advanceTimersByTimeAsync(900);
    streamController?.enqueue({
      type: "tool-input-start",
      id: "call-1",
      toolName: "read_file",
    });
    await expect(started).resolves.toMatchObject({
      done: false,
      value: { type: "tool_call_start", id: "call-1" },
    });

    const ended = iterator.next();
    await vi.advanceTimersByTimeAsync(900);
    streamController?.enqueue({ type: "tool-input-end", id: "call-1" });
    await expect(ended).resolves.toMatchObject({
      done: false,
      value: { type: "tool_call_end", id: "call-1" },
    });

    const completion = iterator.next();
    await vi.advanceTimersByTimeAsync(900);
    streamController?.close();
    await expect(completion).resolves.toEqual({ done: true, value: undefined });
  } finally {
    vi.useRealTimers();
  }
});

test("a finish part settles before a simultaneous inactivity deadline", async () => {
  vi.useFakeTimers();
  try {
    let streamController: ReadableStreamDefaultController<unknown> | undefined;
    let reportStreamReady = (): void => undefined;
    const streamReady = new Promise<void>((resolve) => {
      reportStreamReady = resolve;
    });
    const model = {
      specificationVersion: "v4",
      provider: "test",
      modelId: "finish-timeout-race",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("Generation is not used by this test.");
      },
      async doStream(options: { readonly abortSignal?: AbortSignal }) {
        return {
          stream: new ReadableStream({
            start(controller) {
              streamController = controller;
              options.abortSignal?.addEventListener(
                "abort",
                () => controller.error(options.abortSignal?.reason),
                { once: true },
              );
              reportStreamReady();
            },
          }),
        };
      },
    } as unknown as ConstructorParameters<typeof AiSdkModelDriverForTesting>[0]["model"];
    const driver = new AiSdkModelDriverForTesting({
      model,
      maximumOutputTokens: 4_096,
      deadlineMs: 1_000,
      sensitiveValues: [],
    });
    const iterator = driver
      .stream({
        maximumOutputTokens: 4_096,
        messages: [{ role: "user", content: "Finish at the boundary." }],
        tools: [],
        signal: new AbortController().signal,
      })
      [Symbol.asyncIterator]();
    const usage = iterator.next();
    await streamReady;
    await vi.advanceTimersByTimeAsync(999);
    streamController?.enqueue({
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
    });
    await expect(usage).resolves.toMatchObject({
      done: false,
      value: { type: "usage", inputTokens: 1, outputTokens: 1 },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "finish", reason: "stop" },
    });

    const completion = iterator.next();
    await vi.advanceTimersByTimeAsync(1_000);
    streamController?.close();
    await expect(completion).resolves.toEqual({ done: true, value: undefined });
  } finally {
    vi.useRealTimers();
  }
});

test("the unified driver makes one external attempt when DeepSeek returns a retryable failure", async () => {
  let requestCount = 0;
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () => {
      requestCount += 1;
      return Response.json(
        {
          error: {
            message: "The provider is unavailable.",
            type: "server_error",
            code: "provider_unavailable",
          },
        },
        { status: 503 },
      );
    },
  });
  const { driver } = await targets.resolve({
    targetId: "deepseek-v4-pro.direct",
    allowExperimental: false,
    signal: new AbortController().signal,
  });

  const error = await collectError(
    driver.stream({
      maximumOutputTokens: 4_096,
      messages: [{ role: "user", content: "Answer" }],
      tools: [],
      signal: new AbortController().signal,
    }),
  );

  expect({ requestCount, error }).toMatchObject({
    requestCount: 1,
    error: {
      category: "provider",
      status: 503,
      providerCode: "provider_unavailable",
      responseSummary: "The provider is unavailable.",
    },
  });
});

test("the unified driver accepts normalized text above the former 512 KiB field limit", async () => {
  const oversizedText = "x".repeat(512 * 1024 + 1);
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () =>
      new Response(
        `data: ${JSON.stringify({
          id: "oversized-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "deepseek-v4-pro",
          choices: [{ index: 0, delta: { content: oversizedText }, finish_reason: null }],
        })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" }, status: 200 },
      ),
  });
  const { driver } = await targets.resolve({
    targetId: "deepseek-v4-pro.direct",
    allowExperimental: false,
    signal: new AbortController().signal,
  });

  const events = await collect(
    driver.stream({
      maximumOutputTokens: 4_096,
      messages: [{ role: "user", content: "Answer" }],
      tools: [],
      signal: new AbortController().signal,
    }),
  );

  expect(events.length).toBeGreaterThanOrEqual(1);
  expect(events[0]).toMatchObject({ type: "text_delta" });
  expect(events[0]?.type === "text_delta" ? events[0].text.length : 0).toBe(oversizedText.length);
});

test("the unified driver accepts reasoning above the former 512 KiB field limit", async () => {
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () =>
      new Response(oversizedReasoningDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
  });
  const { driver } = await targets.resolve({
    targetId: "deepseek-v4-pro.direct",
    allowExperimental: false,
    signal: new AbortController().signal,
  });

  const events = await collect(
    driver.stream({
      maximumOutputTokens: 4_096,
      messages: [{ role: "user", content: "Answer" }],
      tools: [],
      signal: new AbortController().signal,
    }),
  );
  const reasoning = events.find((event) => event.type === "reasoning_delta");
  expect(reasoning?.type === "reasoning_delta" ? reasoning.text.length : 0).toBe(512 * 1024 + 1);
});

test("the unified driver retains the independent tool-argument stream limit", async () => {
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () =>
      new Response(oversizedToolArgumentsDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
  });
  const { driver } = await targets.resolve({
    targetId: "deepseek-v4-pro.direct",
    allowExperimental: false,
    signal: new AbortController().signal,
  });

  const error = await collectError(
    driver.stream({
      maximumOutputTokens: 4_096,
      messages: [{ role: "user", content: "Answer" }],
      tools: [readFileDefinition],
      signal: new AbortController().signal,
    }),
  );

  expect(error).toMatchObject({
    category: "protocol_incompatibility",
    message: "The model provider response exceeded Adam's stream limit.",
  });
});

test("the unified driver preserves explicit Provider V4 reasoning boundaries", async () => {
  const model = {
    specificationVersion: "v4",
    provider: "test",
    modelId: "reasoning-boundaries",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("Generation is not used by this test.");
    },
    async doStream() {
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "reasoning-start", id: "provider-private-id" });
            controller.enqueue({ type: "reasoning-end", id: "provider-private-id" });
            controller.close();
          },
        }),
      };
    },
  } as unknown as ConstructorParameters<typeof AiSdkModelDriverForTesting>[0]["model"];
  const driver = new AiSdkModelDriverForTesting({
    model,
    maximumOutputTokens: 4_096,
    deadlineMs: 120_000,
    sensitiveValues: [],
  });

  const events = await collect(
    driver.stream({
      maximumOutputTokens: 4_096,
      messages: [{ role: "user", content: "Preserve the boundary." }],
      tools: [],
      signal: new AbortController().signal,
    }),
  );

  expect(events).toEqual([
    { type: "reasoning_start", id: "provider-reasoning-0", artifactType: "provider_reasoning" },
    { type: "reasoning_end", id: "provider-reasoning-0" },
  ]);
});

test.each([
  { failure: "error-part" as const, category: "protocol_incompatibility" },
  { failure: "stream-rejection" as const, category: "unknown" },
])(
  "the unified driver flushes an explicit reasoning end before a $failure failure",
  async ({ category, failure }) => {
    let ordinal = 0;
    const model = {
      specificationVersion: "v4",
      provider: "test",
      modelId: `reasoning-end-${failure}`,
      supportedUrls: {},
      async doGenerate() {
        throw new Error("Generation is not used by this test.");
      },
      async doStream() {
        return {
          stream: new ReadableStream(
            {
              pull(controller) {
                ordinal += 1;
                if (ordinal === 1) {
                  controller.enqueue({ type: "reasoning-start", id: "provider-private-id" });
                } else if (ordinal === 2) {
                  controller.enqueue({
                    type: "reasoning-delta",
                    id: "provider-private-id",
                    delta: "Provider settled this block.",
                  });
                } else if (ordinal === 3) {
                  controller.enqueue({ type: "reasoning-end", id: "provider-private-id" });
                } else if (failure === "error-part") {
                  controller.enqueue({ type: "error", error: new Error("provider stream error") });
                  controller.close();
                } else {
                  controller.error(new Error("provider iterator rejected"));
                }
              },
            },
            { highWaterMark: 0 },
          ),
        };
      },
    } as unknown as ConstructorParameters<typeof AiSdkModelDriverForTesting>[0]["model"];
    const driver = new AiSdkModelDriverForTesting({
      model,
      maximumOutputTokens: 4_096,
      deadlineMs: 120_000,
      sensitiveValues: [],
    });
    const events: ModelEvent[] = [];
    let observedFailure: unknown;

    try {
      for await (const event of driver.stream({
        maximumOutputTokens: 4_096,
        messages: [{ role: "user", content: "Preserve provider settlement truth." }],
        tools: [],
        signal: new AbortController().signal,
      })) {
        events.push(event);
      }
    } catch (error) {
      observedFailure = error;
    }

    expect(events).toEqual([
      { type: "reasoning_start", id: "provider-reasoning-0", artifactType: "provider_reasoning" },
      {
        type: "reasoning_delta",
        id: "provider-reasoning-0",
        text: "Provider settled this block.",
      },
      { type: "reasoning_end", id: "provider-reasoning-0" },
    ]);
    expect(observedFailure).toMatchObject({ category });
  },
);

test("the unified driver counts every Provider V4 part against the 2,000,000 part ceiling", async () => {
  let emitted = 0;
  const model = {
    specificationVersion: "v4",
    provider: "test",
    modelId: "part-count",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("Generation is not used by this test.");
    },
    async doStream() {
      return {
        stream: new ReadableStream(
          {
            pull(controller) {
              emitted += 1;
              controller.enqueue({ type: "response-metadata" });
            },
          },
          { highWaterMark: 0 },
        ),
      };
    },
  } as unknown as ConstructorParameters<typeof AiSdkModelDriverForTesting>[0]["model"];
  const driver = new AiSdkModelDriverForTesting({
    model,
    maximumOutputTokens: 4_096,
    deadlineMs: 120_000,
    sensitiveValues: [],
  });
  const request = {
    maximumOutputTokens: 4_096,
    messages: [{ role: "user", content: "Count parts." }] as const,
    tools: [],
    signal: new AbortController().signal,
  };

  await expect(collectError(driver.stream(request))).resolves.toMatchObject({
    category: "protocol_incompatibility",
    message: "The model provider response exceeded Adam's stream limit.",
  });
  expect(emitted).toBe(2_000_001);
}, 10_000);

test("the target snapshot reports exact Certified identities and safe credential readiness", async () => {
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-secret-key" },
  });

  const snapshot = await targets.snapshot({
    discoverGateway: false,
    signal: new AbortController().signal,
  });

  expect(snapshot).toEqual({
    targets: [
      {
        identity: {
          targetId: "deepseek-v4-flash.direct",
          vendor: "deepseek",
          modelId: "deepseek-v4-flash",
          route: "direct",
          profileVersion: 3,
          certification: "certified",
        },
        readiness: { status: "available", credentialSource: "DEEPSEEK_API_KEY" },
        contextProfile: {
          version: 2,
          contextWindowTokens: 1_000_000,
          maximumOutputTokens: 384_000,
          ordinaryOutputReserveTokens: 4_096,
          compactionSummaryMaximumOutputTokens: 32_768,
          compactAtTokens: 900_000,
          postCompactTargetTokens: 200_000,
          retainedTargetTokens: 20_000,
          estimatorVersion: 1,
        },
        connectionTest: "supported",
        thinkingCapability: expectedDirectDeepSeekThinkingCapability({
          targetId: "deepseek-v4-flash.direct",
          vendor: "deepseek",
          modelId: "deepseek-v4-flash",
          route: "direct",
          profileVersion: 3,
          certification: "certified",
        }),
      },
      {
        identity: {
          targetId: "deepseek-v4-pro.direct",
          vendor: "deepseek",
          modelId: "deepseek-v4-pro",
          route: "direct",
          profileVersion: 3,
          certification: "certified",
        },
        readiness: { status: "available", credentialSource: "DEEPSEEK_API_KEY" },
        contextProfile: {
          version: 2,
          contextWindowTokens: 1_000_000,
          maximumOutputTokens: 384_000,
          ordinaryOutputReserveTokens: 4_096,
          compactionSummaryMaximumOutputTokens: 32_768,
          compactAtTokens: 900_000,
          postCompactTargetTokens: 200_000,
          retainedTargetTokens: 20_000,
          estimatorVersion: 1,
        },
        connectionTest: "supported",
        thinkingCapability: expectedDirectDeepSeekThinkingCapability({
          targetId: "deepseek-v4-pro.direct",
          vendor: "deepseek",
          modelId: "deepseek-v4-pro",
          route: "direct",
          profileVersion: 3,
          certification: "certified",
        }),
      },
      {
        identity: {
          targetId: "deepseek-v4-flash-vision-exp.direct",
          vendor: "deepseek",
          modelId: "deepseek-v4-flash-vision-exp",
          route: "direct",
          profileVersion: 1,
          certification: "certified",
        },
        readiness: { status: "available", credentialSource: "DEEPSEEK_API_KEY" },
        contextProfile: {
          version: 2,
          contextWindowTokens: 1_000_000,
          maximumOutputTokens: 384_000,
          ordinaryOutputReserveTokens: 4_096,
          compactionSummaryMaximumOutputTokens: 32_768,
          compactAtTokens: 900_000,
          postCompactTargetTokens: 200_000,
          retainedTargetTokens: 20_000,
          estimatorVersion: 1,
        },
        modalityProfile: {
          profileVersion: 1,
          explicitUserImages: "supported",
          imageToolResults: "unsupported",
        },
        upstreamLifecycle: "experimental",
        connectionTest: "supported",
        thinkingCapability: expectedDirectDeepSeekThinkingCapability({
          targetId: "deepseek-v4-flash-vision-exp.direct",
          vendor: "deepseek",
          modelId: "deepseek-v4-flash-vision-exp",
          route: "direct",
          profileVersion: 1,
          certification: "certified",
        }),
      },
      {
        identity: {
          targetId: "poolside-laguna-s-2.1-free.gateway",
          vendor: "poolside",
          modelId: "poolside/laguna-s-2.1-free",
          route: "vercel-ai-gateway",
          upstreamProviderId: "poolside",
          profileVersion: 1,
          certification: "experimental",
        },
        readiness: { status: "missing", credentialSource: "AI_GATEWAY_API_KEY" },
        contextProfile: {
          version: 1,
          contextWindowTokens: 65_536,
          maximumOutputTokens: 32_768,
          compactAtTokens: 32_768,
          postCompactTargetTokens: 24_576,
          retainedTargetTokens: 8_192,
          estimatorVersion: 1,
        },
      },
    ],
  });
  expect(JSON.stringify(snapshot)).not.toContain("test-secret-key");
  expect(snapshot.targets.every(({ identity }) => Object.isFrozen(identity))).toBe(true);
});

function expectedDirectDeepSeekThinkingCapability(targetIdentity: ModelTargetIdentity) {
  return {
    schemaVersion: 1,
    capabilityId: `deepseek-chat-thinking:${targetIdentity.targetId}:target-profile-${targetIdentity.profileVersion}`,
    capabilityVersion: 1,
    capabilityDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    targetIdentity,
    providerProfile: {
      id: "@ai-sdk/deepseek/chat",
      version:
        targetIdentity.profileVersion >= 3 ||
        targetIdentity.modelId === "deepseek-v4-flash-vision-exp"
          ? "3.0.30"
          : "3.0.28",
      requestPath: "provider_options.deepseek",
    },
    supportsOff: true,
    defaultLevelId: "high",
    providerDefault: { effectiveLevelId: "high", mutable: true },
    levels: [
      {
        id: "off",
        label: "Off",
        effectiveLevelId: "off",
        mapping: {
          requestPath: "provider_options.deepseek",
          thinkingType: "disabled",
        },
      },
      {
        id: "low",
        label: "Low",
        effectiveLevelId: "low",
        mapping: {
          requestPath: "provider_options.deepseek",
          thinkingType: "enabled",
          reasoningEffort: "low",
        },
      },
      {
        id: "high",
        label: "High",
        effectiveLevelId: "high",
        mapping: {
          requestPath: "provider_options.deepseek",
          thinkingType: "enabled",
          reasoningEffort: "high",
        },
      },
      {
        id: "max",
        label: "Max",
        effectiveLevelId: "max",
        mapping: {
          requestPath: "provider_options.deepseek",
          thinkingType: "enabled",
          reasoningEffort: "max",
        },
      },
    ],
    reasoningArtifact: "provider_reasoning",
  };
}

test("current Direct DeepSeek v3 selection retains exact historical v2 and v1 resolution", async () => {
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
  });
  const current = await targets.resolve({
    targetId: "deepseek-v4-flash.direct",
    allowExperimental: false,
    signal: new AbortController().signal,
  });
  const historicalV2 = await targets.resolve({
    targetId: "deepseek-v4-flash.direct",
    targetIdentity: {
      ...current.identity,
      profileVersion: 2,
    },
    allowExperimental: false,
    signal: new AbortController().signal,
  });
  const historicalV1 = await targets.resolve({
    targetId: "deepseek-v4-flash.direct",
    targetIdentity: {
      ...current.identity,
      profileVersion: 1,
    },
    allowExperimental: false,
    signal: new AbortController().signal,
  });

  expect(current).toMatchObject({
    identity: { profileVersion: 3 },
    contextProfile: { version: 2, maximumOutputTokens: 384_000 },
  });
  expect(historicalV2).toMatchObject({
    identity: { profileVersion: 2 },
    contextProfile: { version: 2, maximumOutputTokens: 384_000 },
  });
  expect(historicalV1).toMatchObject({
    identity: { profileVersion: 1 },
    contextProfile: { version: 1, maximumOutputTokens: 32_768 },
  });
  await expect(
    targets.snapshot({ includeHistoricalProfiles: true, signal: new AbortController().signal }),
  ).resolves.toMatchObject({
    targets: [
      { identity: { targetId: "deepseek-v4-flash.direct", profileVersion: 3 } },
      { identity: { targetId: "deepseek-v4-pro.direct", profileVersion: 3 } },
      { identity: { targetId: "deepseek-v4-flash.direct", profileVersion: 2 } },
      { identity: { targetId: "deepseek-v4-pro.direct", profileVersion: 2 } },
      { identity: { targetId: "deepseek-v4-flash.direct", profileVersion: 1 } },
      { identity: { targetId: "deepseek-v4-pro.direct", profileVersion: 1 } },
      {
        identity: { targetId: "deepseek-v4-flash-vision-exp.direct", profileVersion: 1 },
      },
      { identity: { targetId: "poolside-laguna-s-2.1-free.gateway", profileVersion: 1 } },
    ],
  });
});

test("historical target resolution rejects a conflicting target ID and exact identity", async () => {
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
  });

  await expect(
    targets.resolve({
      targetId: "deepseek-v4-pro.direct",
      targetIdentity: {
        targetId: "deepseek-v4-flash.direct",
        vendor: "deepseek",
        modelId: "deepseek-v4-flash",
        route: "direct",
        profileVersion: 1,
        certification: "certified",
      },
      allowExperimental: false,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "target_not_found" });
});

test("model targets reject an invalid shared provider deadline", () => {
  expect(() =>
    createModelTargets({
      environment: {},
      deadlineMs: 0,
    }),
  ).toThrowError("The model request deadline must be a positive safe integer.");
});

test("the Gateway target requires an explicit Experimental opt-in", async () => {
  const targets = createModelTargets({
    environment: { AI_GATEWAY_API_KEY: "test-gateway-key" },
  });

  const resolution = targets.resolve({
    targetId: "poolside-laguna-s-2.1-free.gateway",
    allowExperimental: false,
    signal: new AbortController().signal,
  });
  const error = await resolution.catch((resolutionError: unknown) => resolutionError);

  expect(error).toBeInstanceOf(ModelTargetError);
  expect(error).toMatchObject({
    code: "experimental_not_allowed",
    message:
      "poolside-laguna-s-2.1-free.gateway is Experimental and non-certifying. Explicit opt-in is required.",
  });
});

test("an opted-in Gateway target resolves only as an exact Experimental identity", async () => {
  const targets = createModelTargets({
    environment: { AI_GATEWAY_API_KEY: "test-gateway-key" },
  });

  const { identity } = await targets.resolve({
    targetId: "poolside-laguna-s-2.1-free.gateway",
    allowExperimental: true,
    signal: new AbortController().signal,
  });

  expect(identity).toEqual({
    targetId: "poolside-laguna-s-2.1-free.gateway",
    vendor: "poolside",
    modelId: "poolside/laguna-s-2.1-free",
    route: "vercel-ai-gateway",
    upstreamProviderId: "poolside",
    profileVersion: 1,
    certification: "experimental",
  });
});

test("the Experimental Gateway target pins one upstream in the public V4 request", async () => {
  const requests: Array<{
    readonly url: string;
    readonly modelId: string | null;
    readonly body: Record<string, unknown>;
  }> = [];
  const targets = createModelTargets({
    environment: { AI_GATEWAY_API_KEY: "test-gateway-key" },
    fetch: async (input, init) => {
      requests.push({
        url: input instanceof Request ? input.url : String(input),
        modelId: new Headers(init?.headers).get("ai-language-model-id"),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(answerOnlyGatewayStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  });
  const { driver } = await targets.resolve({
    targetId: "poolside-laguna-s-2.1-free.gateway",
    allowExperimental: true,
    signal: new AbortController().signal,
  });

  const events = await collect(
    driver.stream({
      maximumOutputTokens: 4_096,
      messages: [{ role: "user", content: "Introduce yourself" }],
      tools: [],
      signal: new AbortController().signal,
    }),
  );

  expect(requests).toEqual([
    {
      url: "https://ai-gateway.vercel.sh/v4/ai/language-model",
      modelId: "poolside/laguna-s-2.1-free",
      body: expect.objectContaining({
        prompt: [{ role: "user", content: [{ type: "text", text: "Introduce yourself" }] }],
        providerOptions: { gateway: { only: ["poolside"] } },
      }),
    },
  ]);
  const firstRequest = requests[0];
  if (firstRequest === undefined) {
    throw new Error("Expected one captured Gateway request.");
  }
  const { providerOptions } = firstRequest.body;
  expect(Object.keys((providerOptions as { gateway: object }).gateway)).toEqual(["only"]);
  expect(events).toEqual([
    { type: "text_delta", text: "Experimental reply." },
    { type: "usage", inputTokens: 4, outputTokens: 2 },
    { type: "finish", reason: "stop", rawReason: "stop" },
  ]);
});

test("the Experimental Gateway target reports its own missing credential", async () => {
  const targets = createModelTargets({ environment: {} });

  const resolution = targets.resolve({
    targetId: "poolside-laguna-s-2.1-free.gateway",
    allowExperimental: true,
    signal: new AbortController().signal,
  });
  const error = await resolution.catch((resolutionError: unknown) => resolutionError);

  expect(error).toBeInstanceOf(ModelTargetError);
  expect(error).toMatchObject({
    code: "credential_missing",
    message:
      "AI_GATEWAY_API_KEY is required for the Experimental Gateway target. Set it and retry the same target.",
  });
});

test("resolving a Direct target fails with typed credential guidance when its key is missing", async () => {
  const targets = createModelTargets({ environment: {} });

  const resolution = targets.resolve({
    targetId: "deepseek-v4-pro.direct",
    allowExperimental: false,
    signal: new AbortController().signal,
  });

  const error = await resolution.catch((resolutionError: unknown) => resolutionError);

  expect(error).toBeInstanceOf(ModelTargetError);
  expect(error).toMatchObject({
    name: "ModelTargetError",
    code: "credential_missing",
    message:
      "DEEPSEEK_API_KEY is required for deepseek-v4-pro.direct. Set it and retry the same target.",
  });
});

test("the target resolver rejects every model identity outside the exact built-in allowlist", async () => {
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
  });

  const resolution = targets.resolve({
    targetId: "deepseek-chat.direct\nsecret-control-text",
    allowExperimental: false,
    signal: new AbortController().signal,
  });
  const error = await resolution.catch((resolutionError: unknown) => resolutionError);

  expect(error).toBeInstanceOf(ModelTargetError);
  expect(error).toMatchObject({
    code: "target_not_found",
    message:
      "Unknown model target. Choose deepseek-v4-flash.direct, deepseek-v4-pro.direct, deepseek-v4-flash-vision-exp.direct, or the documented Experimental Gateway target.",
  });
});

test("credentials never imply a target when no explicit or legacy selector exists", () => {
  expect(() => selectModelTargetId({ DEEPSEEK_API_KEY: "test-deepseek-key" })).toThrowError(
    expect.objectContaining({
      name: "ModelTargetError",
      code: "target_not_selected",
      message:
        "No model target selected. Set ADAM_AGENT_TARGET=deepseek-v4-flash.direct or ADAM_AGENT_TARGET=fake.local.",
    }),
  );
});

test("the temporary DeepSeek selectors map only their three exact compatibility models", () => {
  expect([
    selectModelTargetId({ ADAM_AGENT_PROVIDER: "deepseek" }),
    selectModelTargetId({
      ADAM_AGENT_PROVIDER: "deepseek",
      ADAM_AGENT_MODEL: "deepseek-v4-flash",
    }),
    selectModelTargetId({
      ADAM_AGENT_PROVIDER: "deepseek",
      ADAM_AGENT_MODEL: "deepseek-v4-pro",
    }),
    selectModelTargetId({
      ADAM_AGENT_PROVIDER: "deepseek",
      ADAM_AGENT_MODEL: "deepseek-v4-flash-vision-exp",
    }),
  ]).toEqual([
    "deepseek-v4-pro.direct",
    "deepseek-v4-flash.direct",
    "deepseek-v4-pro.direct",
    "deepseek-v4-flash-vision-exp.direct",
  ]);
});

test("the legacy DeepSeek selector rejects a configured model outside the exact V4 allowlist", () => {
  expect(() =>
    selectModelTargetId({
      ADAM_AGENT_PROVIDER: "deepseek",
      ADAM_AGENT_MODEL: "deepseek-chat",
    }),
  ).toThrowError(
    expect.objectContaining({
      code: "invalid_selector",
      message:
        "ADAM_AGENT_MODEL must be deepseek-v4-flash, deepseek-v4-pro, or deepseek-v4-flash-vision-exp when ADAM_AGENT_PROVIDER=deepseek.",
    }),
  );
});

test("the new target selector rejects simultaneous legacy selectors", () => {
  expect(() =>
    selectModelTargetId({
      ADAM_AGENT_TARGET: "deepseek-v4-pro.direct",
      ADAM_AGENT_PROVIDER: "deepseek",
      ADAM_AGENT_MODEL: "deepseek-v4-pro",
    }),
  ).toThrowError(
    expect.objectContaining({
      code: "selector_conflict",
      message: "ADAM_AGENT_TARGET cannot be combined with ADAM_AGENT_PROVIDER or ADAM_AGENT_MODEL.",
    }),
  );
});

async function collect(stream: AsyncIterable<ModelEvent>): Promise<readonly ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

async function collectError(stream: AsyncIterable<ModelEvent>): Promise<ModelDriverError> {
  try {
    await collect(stream);
  } catch (error) {
    if (error instanceof ModelDriverError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the model driver to fail.");
}

function visionImageMessage() {
  return {
    role: "user" as const,
    content: [
      { type: "text" as const, text: "Describe this image." },
      {
        type: "file" as const,
        artifactId: `sha256:${"a".repeat(64)}` as const,
        mediaType: "image/png" as const,
        bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
      },
    ],
  };
}

const readFileDefinition = {
  name: "read_file",
  description: "Read a UTF-8 text file inside the workspace.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
} as const;

const answerOnlyDeepSeekStream = `data: {"id":"answer-1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"content":"Hello, Adam."},"finish_reason":null}]}

data: {"id":"answer-1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}

data: [DONE]

`;

const detailedUsageDeepSeekStream = `data: {"id":"usage-1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":null}]}

data: {"id":"usage-1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10,"prompt_cache_hit_tokens":2,"prompt_cache_miss_tokens":5,"completion_tokens_details":{"reasoning_tokens":1}}}

data: [DONE]

`;

function finishReasonDeepSeekStream(rawReason: string): string {
  return `data: ${JSON.stringify({
    id: "finish-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek-v4-pro",
    choices: [{ index: 0, delta: {}, finish_reason: rawReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })}\n\ndata: [DONE]\n\n`;
}

const reasoningToolDeepSeekStream = `data: {"id":"reasoning-1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"reasoning_content":"I need "},"finish_reason":null}]}

data: {"id":"reasoning-1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"reasoning_content":"the README.","tool_calls":[{"index":0,"id":"read-project","type":"function","function":{"name":"read_file","arguments":"{\\"pa"}}]},"finish_reason":null}]}

data: {"id":"reasoning-1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}

data: {"id":"reasoning-1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-pro","choices":[],"usage":{"prompt_tokens":13,"completion_tokens":9,"total_tokens":22}}

data: [DONE]

`;

const multipleToolDeepSeekStream = `data: {"id":"tools-1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"read-a","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a"}},{"index":1,"id":"read-b","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"b"}}]},"finish_reason":null}]}

data: {"id":"tools-1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":".txt\\"}"}},{"index":1,"function":{"arguments":".txt\\"}"}}]},"finish_reason":"tool_calls"}]}

data: {"id":"tools-1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-pro","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":8,"total_tokens":17}}

data: [DONE]

`;

const oversizedReasoningDeepSeekStream = `data: ${JSON.stringify({
  id: "oversized-reasoning-1",
  object: "chat.completion.chunk",
  created: 1,
  model: "deepseek-v4-pro",
  choices: [
    {
      index: 0,
      delta: { reasoning_content: "r".repeat(512 * 1024 + 1) },
      finish_reason: null,
    },
  ],
})}\n\ndata: [DONE]\n\n`;

const oversizedToolArgumentsDeepSeekStream = `data: ${JSON.stringify({
  id: "oversized-tool-1",
  object: "chat.completion.chunk",
  created: 1,
  model: "deepseek-v4-pro",
  choices: [
    {
      index: 0,
      delta: {
        tool_calls: [
          {
            index: 0,
            id: "read-oversized",
            type: "function",
            function: { name: "read_file", arguments: "x".repeat(2 * 1024 * 1024 + 1) },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
})}\n\ndata: [DONE]\n\n`;

const finalAnswerDeepSeekStream = `data: {"id":"answer-2","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"content":"The project is Adam Agent."},"finish_reason":null}]}

data: {"id":"answer-2","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":31,"completion_tokens":6,"total_tokens":37}}

data: [DONE]

`;

const answerOnlyGatewayStream = `data: {"type":"text-start","id":"text-0"}

data: {"type":"text-delta","id":"text-0","delta":"Experimental reply."}

data: {"type":"text-end","id":"text-0"}

data: {"type":"finish","usage":{"inputTokens":{"total":4,"noCache":4,"cacheRead":0},"outputTokens":{"total":2,"text":2,"reasoning":0}},"finishReason":{"unified":"stop","raw":"stop"}}

`;
