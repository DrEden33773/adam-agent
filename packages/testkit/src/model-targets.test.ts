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
  OpenAICompatibleModelDriver,
  type RuntimeEvent,
  selectModelTargetId,
} from "@adam-agent/agent";
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
      signal: new AbortController().signal,
    }),
  );

  expect({ identity: resolved.identity, requests, events }).toEqual({
    identity: {
      targetId: "deepseek-v4-flash.direct",
      vendor: "deepseek",
      modelId: "deepseek-v4-flash",
      route: "direct",
      profileVersion: 1,
      certification: "certified",
    },
    requests: [
      {
        url: "https://api.deepseek.com/chat/completions",
        body: expect.objectContaining({
          model: "deepseek-v4-flash",
          messages: [{ role: "user", content: "Introduce yourself" }],
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
    { type: "reasoning_delta", text: "I need " },
    { type: "reasoning_delta", text: "the README." },
    { type: "tool_call_start", id: "read-project", name: "read_file" },
    { type: "tool_call_delta", id: "read-project", json: '{"pa' },
    { type: "tool_call_delta", id: "read-project", json: 'th":"README.md"}' },
    { type: "tool_call_end", id: "read-project" },
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
      signal: new AbortController().signal,
    });

    expect(await collect(unified.stream(request()))).toEqual(
      await collect(direct.stream(request())),
    );
  },
);

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
  const { driver } = await targets.resolve({
    targetId: "deepseek-v4-pro.direct",
    allowExperimental: false,
    signal: new AbortController().signal,
  });
  const store = createInMemorySessionStore();
  const session = new AgentSession({
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
    expect(events).toContainEqual({
      type: "tool_completed",
      callId: "read-project",
      name: "read_file",
      output: { path: "README.md", content: "# Adam Agent\n", truncated: false },
    });
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

test("the unified driver owns one deadline across the complete provider stream", async () => {
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

test("the unified driver rejects normalized text beyond Adam's stream limit", async () => {
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

  const error = await collectError(
    driver.stream({
      messages: [{ role: "user", content: "Answer" }],
      tools: [],
      signal: new AbortController().signal,
    }),
  );

  expect(error).toMatchObject({
    category: "protocol_incompatibility",
    message: "The model provider response exceeded Adam's stream limit.",
  });
});

test.each([
  {
    name: "reasoning",
    stream: () => oversizedReasoningDeepSeekStream,
  },
  {
    name: "tool arguments",
    stream: () => oversizedToolArgumentsDeepSeekStream,
  },
])("the unified driver rejects oversized $name", async ({ stream }) => {
  const targets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () =>
      new Response(stream(), {
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
          profileVersion: 1,
          certification: "certified",
        },
        readiness: { status: "available", credentialSource: "DEEPSEEK_API_KEY" },
        contextProfile: {
          version: 1,
          contextWindowTokens: 1_000_000,
          maximumOutputTokens: 32_768,
          compactAtTokens: 800_000,
          postCompactTargetTokens: 200_000,
          retainedTargetTokens: 20_000,
          estimatorVersion: 1,
        },
      },
      {
        identity: {
          targetId: "deepseek-v4-pro.direct",
          vendor: "deepseek",
          modelId: "deepseek-v4-pro",
          route: "direct",
          profileVersion: 1,
          certification: "certified",
        },
        readiness: { status: "available", credentialSource: "DEEPSEEK_API_KEY" },
        contextProfile: {
          version: 1,
          contextWindowTokens: 1_000_000,
          maximumOutputTokens: 32_768,
          compactAtTokens: 800_000,
          postCompactTargetTokens: 200_000,
          retainedTargetTokens: 20_000,
          estimatorVersion: 1,
        },
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
      "Unknown model target. Choose deepseek-v4-flash.direct, deepseek-v4-pro.direct, or the documented Experimental Gateway target.",
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

test("the temporary DeepSeek selectors map only their two exact legacy models", () => {
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
  ]).toEqual(["deepseek-v4-pro.direct", "deepseek-v4-flash.direct", "deepseek-v4-pro.direct"]);
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
        "ADAM_AGENT_MODEL must be deepseek-v4-flash or deepseek-v4-pro when ADAM_AGENT_PROVIDER=deepseek.",
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
