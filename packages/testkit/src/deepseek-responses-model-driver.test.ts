import type { ModelRequest } from "@adam-agent/agent";
import { ModelDriverError } from "@adam-agent/agent";
import { DirectDeepSeekResponsesModelDriverForTesting } from "@adam-agent/agent/internal-testing";
import { expect, test, vi } from "vitest";

const approvedPlan = {
  version: 1,
  sessionId: "session-plan-1",
  commandId: "approve-plan-1",
  kickoffRunId: "run-plan-1",
  cycleId: "cycle-plan-1",
  revision: 2,
  planId: "plan-1",
  contentDigest: `sha256:${"a".repeat(64)}`,
  title: "Ship the exact Plan",
  policyVersion: "plan-policy.hybrid-v1",
  toolProfileDigest: `sha256:${"b".repeat(64)}`,
  markdown: "# Exact Plan\n\n1. Keep this byte-for-byte.",
} as NonNullable<ModelRequest["approvedPlan"]>;

const approvedPlanProviderText =
  "Adam runtime approved Plan projection v1 (assistant-owned context; no additional prompt authority):\n" +
  JSON.stringify(approvedPlan);

test("Direct Responses maps one stateless answer-only request and semantic SSE", async () => {
  let captured: { readonly input: string | URL | Request; readonly init?: RequestInit } | undefined;
  const driver = new DirectDeepSeekResponsesModelDriverForTesting({
    apiKey: "test-secret",
    baseURL: "https://api.deepseek.com",
    deadlineMs: 10_000,
    maximumOutputTokens: 4_096,
    model: "deepseek-v4-flash-vision-exp",
    fetch: async (input, init) => {
      captured = { input, ...(init === undefined ? {} : { init }) };
      return new Response(
        [
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n',
          'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
        ].join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const request: ModelRequest = {
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
    ],
    tools: [],
    maximumOutputTokens: 2_048,
    signal: new AbortController().signal,
  };

  const events = [];
  for await (const event of driver.stream(request)) {
    events.push(event);
  }

  expect(events).toEqual([
    { type: "text_delta", text: "hello" },
    { type: "usage", inputTokens: 3, outputTokens: 1 },
    { type: "finish", reason: "stop", rawReason: "completed" },
  ]);
  expect(String(captured?.input)).toBe("https://api.deepseek.com/responses");
  expect(captured?.init?.headers).toEqual({
    authorization: "Bearer test-secret",
    "content-type": "application/json",
  });
  expect(JSON.parse(String(captured?.init?.body))).toEqual({
    model: "deepseek-v4-flash-vision-exp",
    input: [
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
    ],
    max_output_tokens: 2_048,
    stream: true,
  });
});

test("Direct Responses projects an object-only union tool schema on the provider wire", async () => {
  let body: { readonly tools?: readonly unknown[] } | undefined;
  const canonicalInputSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    anyOf: [
      {
        type: "object",
        properties: { kind: { type: "string", const: "content" } },
        required: ["kind"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { kind: { type: "string", const: "path" } },
        required: ["kind"],
        additionalProperties: false,
      },
    ],
  } as const;
  const canonicalBefore = structuredClone(canonicalInputSchema);
  const driver = new DirectDeepSeekResponsesModelDriverForTesting({
    apiKey: "test-secret",
    baseURL: "https://api.deepseek.com",
    deadlineMs: 10_000,
    maximumOutputTokens: 4_096,
    model: "deepseek-v4-flash-vision-exp",
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as { readonly tools?: readonly unknown[] };
      return new Response(
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    },
  });

  for await (const _event of driver.stream({
    messages: [{ role: "user", content: "Search the repository" }],
    tools: [
      {
        name: "search_repository",
        description: "Search repository content or paths.",
        inputSchema: canonicalInputSchema,
      },
    ],
    maximumOutputTokens: 2_048,
    signal: new AbortController().signal,
  })) {
    // Consume the complete semantic stream.
  }

  expect(body?.tools).toEqual([
    {
      type: "function",
      name: "search_repository",
      description: "Search repository content or paths.",
      parameters: { ...canonicalBefore, type: "object" },
      strict: false,
    },
  ]);
  expect(canonicalInputSchema).toEqual(canonicalBefore);
});

test("Direct Responses serializes the exact approved Plan as one assistant projection", async () => {
  let body: { readonly input: readonly unknown[] } | undefined;
  const driver = new DirectDeepSeekResponsesModelDriverForTesting({
    apiKey: "test-secret",
    baseURL: "https://api.deepseek.com",
    deadlineMs: 10_000,
    maximumOutputTokens: 4_096,
    model: "deepseek-v4-flash-vision-exp",
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as { readonly input: readonly unknown[] };
      return new Response(
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    },
  });

  for await (const _event of driver.stream({
    messages: [
      { role: "system", content: "system" },
      { role: "developer", content: "developer" },
      { role: "user", content: "Implement the approved Plan." },
    ],
    tools: [],
    approvedPlan,
    maximumOutputTokens: 2_048,
    signal: new AbortController().signal,
  })) {
    // Consume the complete semantic stream.
  }

  expect(body?.input).toEqual([
    { role: "system", content: "system" },
    { role: "developer", content: "developer" },
    {
      role: "assistant",
      content: [{ type: "output_text", text: approvedPlanProviderText, annotations: [] }],
    },
    { role: "user", content: "Implement the approved Plan." },
  ]);
});

test("Direct Responses preserves function call identity and emits the image in its tool output", async () => {
  let body: unknown;
  const bytes = Uint8Array.from([1, 2, 3]);
  const driver = new DirectDeepSeekResponsesModelDriverForTesting({
    apiKey: "test-secret",
    baseURL: "https://api.deepseek.com/",
    maximumOutputTokens: 4_096,
    model: "deepseek-v4-flash-vision-exp",
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        { status: 200 },
      );
    },
  });

  for await (const _event of driver.stream({
    messages: [
      { role: "user", content: "inspect the linked image" },
      {
        role: "assistant",
        content: "",
        reasoning: "I must read the linked image.",
        toolCalls: [
          {
            id: "call-image-1",
            name: "read_input_resource",
            argumentsJson: '{"occurrenceId":"image-1"}',
          },
        ],
      },
      {
        role: "tool",
        callId: "call-image-1",
        name: "read_input_resource",
        result: { status: "completed", output: { type: "image" } },
        content: [
          {
            type: "file",
            artifactId: `sha256:${"1".repeat(64)}`,
            mediaType: "image/png",
            bytes,
          },
        ],
      },
    ],
    tools: [],
    maximumOutputTokens: 2_048,
    signal: new AbortController().signal,
  })) {
    // Consume the complete semantic stream.
  }

  expect(body).toMatchObject({
    input: [
      { role: "user", content: "inspect the linked image" },
      {
        type: "reasoning",
        content: [{ type: "reasoning_text", text: "I must read the linked image." }],
      },
      {
        type: "function_call",
        call_id: "call-image-1",
        name: "read_input_resource",
        arguments: '{"occurrenceId":"image-1"}',
      },
      {
        type: "function_call_output",
        call_id: "call-image-1",
        output: [
          {
            type: "input_image",
            detail: "auto",
            image_url: "data:image/png;base64,AQID",
          },
        ],
      },
    ],
  });
});

test("Direct Responses streams reasoning and fragmented function arguments with tool-call finish truth", async () => {
  const driver = new DirectDeepSeekResponsesModelDriverForTesting({
    apiKey: "test-secret",
    baseURL: "https://api.deepseek.com",
    maximumOutputTokens: 4_096,
    model: "deepseek-v4-flash-vision-exp",
    fetch: async () =>
      new Response(
        [
          'data: {"type":"response.reasoning_text.delta","delta":"inspect"}\n\n',
          'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"read_input_resource"}}\n\n',
          'data: {"type":"response.function_call_arguments.delta","item_id":"item-1","delta":"{\\"occurrenceId\\":"}\n\n',
          'data: {"type":"response.function_call_arguments.delta","item_id":"item-1","delta":"\\"image-1\\"}"}\n\n',
          'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"item-1"}}\n\n',
          'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":9,"output_tokens":4,"input_tokens_details":{"cached_tokens":2},"output_tokens_details":{"reasoning_tokens":3}}}}\n\n',
        ].join(""),
        { status: 200 },
      ),
  });
  const events = [];
  for await (const event of driver.stream({
    messages: [{ role: "user", content: "inspect" }],
    tools: [],
    maximumOutputTokens: 2_048,
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }

  expect(events).toEqual([
    {
      type: "reasoning_start",
      id: "provider-reasoning-0",
      artifactType: "provider_reasoning",
    },
    { type: "reasoning_delta", id: "provider-reasoning-0", text: "inspect" },
    { type: "tool_call_start", id: "call-1", name: "read_input_resource" },
    { type: "tool_call_delta", id: "call-1", json: '{"occurrenceId":' },
    { type: "tool_call_delta", id: "call-1", json: '"image-1"}' },
    { type: "tool_call_end", id: "call-1" },
    { type: "reasoning_end", id: "provider-reasoning-0" },
    {
      type: "usage",
      inputTokens: 9,
      outputTokens: 4,
      cachedInputTokens: 2,
      reasoningTokens: 3,
    },
    { type: "finish", reason: "tool_calls", rawReason: "completed" },
  ]);
});

test("Direct Responses preserves caller cancellation during the provider request", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const driver = new DirectDeepSeekResponsesModelDriverForTesting({
    apiKey: "test-secret",
    baseURL: "https://api.deepseek.com",
    maximumOutputTokens: 4_096,
    model: "deepseek-v4-flash-vision-exp",
    fetch: async (_input, init) => {
      const signal = init?.signal as AbortSignal;
      started.resolve(signal);
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  const controller = new AbortController();
  const error = collectError(
    driver.stream({
      messages: [{ role: "user", content: "cancel" }],
      tools: [],
      maximumOutputTokens: 2_048,
      signal: controller.signal,
    }),
  );
  await started.promise;
  controller.abort(new DOMException("cancelled", "AbortError"));

  await expect(error).resolves.toMatchObject({ category: "aborted" });
});

test("Direct Responses cancels an active provider body stream from the caller signal", async () => {
  const bodyStarted = Promise.withResolvers<void>();
  const bodyCancelled = Promise.withResolvers<unknown>();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
        ),
      );
      bodyStarted.resolve();
    },
    cancel(reason) {
      bodyCancelled.resolve(reason);
    },
  });
  const driver = new DirectDeepSeekResponsesModelDriverForTesting({
    apiKey: "test-secret",
    baseURL: "https://api.deepseek.com",
    maximumOutputTokens: 4_096,
    model: "deepseek-v4-flash-vision-exp",
    fetch: async () => new Response(body, { status: 200 }),
  });
  const controller = new AbortController();
  const events: unknown[] = [];
  const consumed = (async () => {
    try {
      for await (const event of driver.stream({
        messages: [{ role: "user", content: "cancel active stream" }],
        tools: [],
        maximumOutputTokens: 2_048,
        signal: controller.signal,
      })) {
        events.push(event);
        controller.abort(new DOMException("cancelled", "AbortError"));
      }
      throw new Error("Expected active stream cancellation to reject.");
    } catch (error) {
      return error;
    }
  })();
  await bodyStarted.promise;

  await expect(consumed).resolves.toMatchObject({ category: "aborted" });
  await expect(bodyCancelled.promise).resolves.toBeInstanceOf(DOMException);
  expect(events).toEqual([{ type: "text_delta", text: "partial" }]);
});

test("Direct Responses resets inactivity only after accepted semantic progress", async () => {
  vi.useFakeTimers();
  try {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const streamReady = Promise.withResolvers<void>();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        streamReady.resolve();
      },
    });
    const driver = new DirectDeepSeekResponsesModelDriverForTesting({
      apiKey: "test-secret",
      baseURL: "https://api.deepseek.com",
      deadlineMs: 1_000,
      maximumOutputTokens: 4_096,
      model: "deepseek-v4-flash-vision-exp",
      fetch: async () => new Response(body, { status: 200 }),
    });
    const iterator = driver
      .stream({
        messages: [{ role: "user", content: "keep progressing" }],
        tools: [],
        maximumOutputTokens: 2_048,
        signal: new AbortController().signal,
      })
      [Symbol.asyncIterator]();
    const first = iterator.next();
    await streamReady.promise;
    await vi.advanceTimersByTimeAsync(900);
    streamController?.enqueue(
      new TextEncoder().encode(
        'data: {"type":"response.output_text.delta","delta":"progress"}\n\n',
      ),
    );
    await expect(first).resolves.toEqual({
      done: false,
      value: { type: "text_delta", text: "progress" },
    });

    const terminal = iterator.next();
    await vi.advanceTimersByTimeAsync(900);
    streamController?.enqueue(
      new TextEncoder().encode(
        'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      ),
    );
    streamController?.close();
    await expect(terminal).resolves.toEqual({
      done: false,
      value: { type: "finish", reason: "stop", rawReason: "completed" },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  } finally {
    vi.useRealTimers();
  }
});

test("Direct Responses times out before its first accepted semantic progress", async () => {
  vi.useFakeTimers();
  try {
    const streamReady = Promise.withResolvers<void>();
    const body = new ReadableStream<Uint8Array>({
      start() {
        streamReady.resolve();
      },
    });
    const driver = new DirectDeepSeekResponsesModelDriverForTesting({
      apiKey: "test-secret",
      baseURL: "https://api.deepseek.com",
      deadlineMs: 1_000,
      maximumOutputTokens: 4_096,
      model: "deepseek-v4-flash-vision-exp",
      fetch: async () => new Response(body, { status: 200 }),
    });
    const error = collectError(
      driver.stream({
        messages: [{ role: "user", content: "never starts" }],
        tools: [],
        maximumOutputTokens: 2_048,
        signal: new AbortController().signal,
      }),
    );
    await streamReady.promise;

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(error).resolves.toMatchObject({ category: "timeout" });
  } finally {
    vi.useRealTimers();
  }
});

test("Direct Responses does not reset inactivity for an empty semantic delta", async () => {
  vi.useFakeTimers();
  try {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const streamReady = Promise.withResolvers<void>();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        streamReady.resolve();
      },
    });
    const driver = new DirectDeepSeekResponsesModelDriverForTesting({
      apiKey: "test-secret",
      baseURL: "https://api.deepseek.com",
      deadlineMs: 1_000,
      maximumOutputTokens: 4_096,
      model: "deepseek-v4-flash-vision-exp",
      fetch: async () => new Response(body, { status: 200 }),
    });
    const iterator = driver
      .stream({
        messages: [{ role: "user", content: "ignore empty progress" }],
        tools: [],
        maximumOutputTokens: 2_048,
        signal: new AbortController().signal,
      })
      [Symbol.asyncIterator]();
    const empty = iterator.next();
    await streamReady.promise;
    await vi.advanceTimersByTimeAsync(900);
    streamController?.enqueue(
      new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":""}\n\n'),
    );
    await expect(empty).resolves.toEqual({
      done: false,
      value: { type: "text_delta", text: "" },
    });
    const timeout = iterator.next().then(
      () => new Error("Expected inactivity timeout."),
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(100);

    await expect(timeout).resolves.toMatchObject({ category: "timeout" });
  } finally {
    vi.useRealTimers();
  }
});

test("Direct Responses stops and cancels its provider reader at the semantic terminal", async () => {
  const cancelled = Promise.withResolvers<unknown>();
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
            ),
          );
          return;
        }
        throw new Error("The provider body was read after its semantic terminal.");
      },
      cancel(reason) {
        cancelled.resolve(reason);
      },
    },
    { highWaterMark: 0 },
  );
  const driver = new DirectDeepSeekResponsesModelDriverForTesting({
    apiKey: "test-secret",
    baseURL: "https://api.deepseek.com",
    maximumOutputTokens: 4_096,
    model: "deepseek-v4-flash-vision-exp",
    fetch: async () => new Response(body, { status: 200 }),
  });
  const events = [];

  for await (const event of driver.stream({
    messages: [{ role: "user", content: "stop at terminal" }],
    tools: [],
    maximumOutputTokens: 2_048,
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }

  expect(events).toEqual([{ type: "finish", reason: "stop", rawReason: "completed" }]);
  await expect(cancelled.promise).resolves.toBeUndefined();
  expect(pulls).toBe(1);
});

test("Direct Responses bounds an unterminated provider SSE frame", async () => {
  const driver = new DirectDeepSeekResponsesModelDriverForTesting({
    apiKey: "test-secret",
    baseURL: "https://api.deepseek.com",
    maximumOutputTokens: 4_096,
    model: "deepseek-v4-flash-vision-exp",
    fetch: async () => new Response(`data: ${"x".repeat(2 * 1024 * 1024 + 1)}`, { status: 200 }),
  });

  await expect(
    collectError(
      driver.stream({
        messages: [{ role: "user", content: "bound the wire" }],
        tools: [],
        maximumOutputTokens: 2_048,
        signal: new AbortController().signal,
      }),
    ),
  ).resolves.toMatchObject({ category: "protocol_incompatibility" });
});

test("Direct Responses bounds cumulative fragmented function arguments", async () => {
  const first = "a".repeat(1024 * 1024 + 1);
  const second = "b".repeat(1024 * 1024);
  const driver = new DirectDeepSeekResponsesModelDriverForTesting({
    apiKey: "test-secret",
    baseURL: "https://api.deepseek.com",
    maximumOutputTokens: 4_096,
    model: "deepseek-v4-flash-vision-exp",
    fetch: async () =>
      new Response(
        [
          'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"read_input_resource"}}\n\n',
          `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "item-1", delta: first })}\n\n`,
          `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "item-1", delta: second })}\n\n`,
        ].join(""),
        { status: 200 },
      ),
  });

  await expect(
    collectError(
      driver.stream({
        messages: [{ role: "user", content: "bound arguments" }],
        tools: [],
        maximumOutputTokens: 2_048,
        signal: new AbortController().signal,
      }),
    ),
  ).resolves.toMatchObject({ category: "protocol_incompatibility" });
});

test("Direct Responses bounds cumulative reasoning and output text", async () => {
  const delta = "x".repeat(2 * 1024 * 1024 - 512);
  const encoder = new TextEncoder();
  let frame = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        frame += 1;
        if (frame <= 33) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: frame % 2 === 0 ? "response.reasoning_text.delta" : "response.output_text.delta", delta })}\n\n`,
            ),
          );
          return;
        }
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
          ),
        );
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const driver = new DirectDeepSeekResponsesModelDriverForTesting({
    apiKey: "test-secret",
    baseURL: "https://api.deepseek.com",
    maximumOutputTokens: 4_096,
    model: "deepseek-v4-flash-vision-exp",
    fetch: async () => new Response(body, { status: 200 }),
  });

  await expect(
    collectError(
      driver.stream({
        messages: [{ role: "user", content: "bound semantic content" }],
        tools: [],
        maximumOutputTokens: 2_048,
        signal: new AbortController().signal,
      }),
    ),
  ).resolves.toMatchObject({ category: "protocol_incompatibility" });
});

test("Direct Responses rejects an oversized function-call call identity", async () => {
  const callId = "c".repeat(1_025);
  const driver = new DirectDeepSeekResponsesModelDriverForTesting({
    apiKey: "test-secret",
    baseURL: "https://api.deepseek.com",
    maximumOutputTokens: 4_096,
    model: "deepseek-v4-flash-vision-exp",
    fetch: async () =>
      new Response(
        `data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "item-1", call_id: callId, name: "read_input_resource" } })}\n\n`,
        { status: 200 },
      ),
  });

  await expect(
    collectError(
      driver.stream({
        messages: [{ role: "user", content: "bound call identity" }],
        tools: [],
        maximumOutputTokens: 2_048,
        signal: new AbortController().signal,
      }),
    ),
  ).resolves.toMatchObject({ category: "protocol_incompatibility" });
});

test("Direct Responses rejects an oversized function-call tool name", async () => {
  const name = "n".repeat(257);
  const driver = new DirectDeepSeekResponsesModelDriverForTesting({
    apiKey: "test-secret",
    baseURL: "https://api.deepseek.com",
    maximumOutputTokens: 4_096,
    model: "deepseek-v4-flash-vision-exp",
    fetch: async () =>
      new Response(
        `data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "item-1", call_id: "call-1", name } })}\n\n`,
        { status: 200 },
      ),
  });

  await expect(
    collectError(
      driver.stream({
        messages: [{ role: "user", content: "bound tool name" }],
        tools: [],
        maximumOutputTokens: 2_048,
        signal: new AbortController().signal,
      }),
    ),
  ).resolves.toMatchObject({ category: "protocol_incompatibility" });
});

test("Direct Responses rejects more than its bounded function-call count", async () => {
  const frames = Array.from({ length: 129 }, (_value, index) => {
    const itemId = `item-${index}`;
    return [
      `data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: itemId, call_id: `call-${index}`, name: "read_input_resource" } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: itemId } })}\n\n`,
    ].join("");
  });
  const driver = new DirectDeepSeekResponsesModelDriverForTesting({
    apiKey: "test-secret",
    baseURL: "https://api.deepseek.com",
    maximumOutputTokens: 4_096,
    model: "deepseek-v4-flash-vision-exp",
    fetch: async () =>
      new Response(
        `${frames.join("")}data: {"type":"response.completed","response":{"status":"completed"}}\n\n`,
        { status: 200 },
      ),
  });

  await expect(
    collectError(
      driver.stream({
        messages: [{ role: "user", content: "bound call count" }],
        tools: [],
        maximumOutputTokens: 2_048,
        signal: new AbortController().signal,
      }),
    ),
  ).resolves.toMatchObject({ category: "protocol_incompatibility" });
});

test("Direct Responses rejects an oversized function-call item identity before retention", async () => {
  const itemId = "i".repeat(1_025);
  const driver = new DirectDeepSeekResponsesModelDriverForTesting({
    apiKey: "test-secret",
    baseURL: "https://api.deepseek.com",
    maximumOutputTokens: 4_096,
    model: "deepseek-v4-flash-vision-exp",
    fetch: async () =>
      new Response(
        [
          `data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: itemId, call_id: "call-1", name: "read_input_resource" } })}\n\n`,
          `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: itemId } })}\n\n`,
          'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        ].join(""),
        { status: 200 },
      ),
  });

  await expect(
    collectError(
      driver.stream({
        messages: [{ role: "user", content: "bound item identity" }],
        tools: [],
        maximumOutputTokens: 2_048,
        signal: new AbortController().signal,
      }),
    ),
  ).resolves.toMatchObject({ category: "protocol_incompatibility" });
});

test("Direct Responses cancels the provider reader when its consumer returns early", async () => {
  const cancelled = Promise.withResolvers<unknown>();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"type":"response.output_text.delta","delta":"enough"}\n\n',
        ),
      );
    },
    cancel(reason) {
      cancelled.resolve(reason);
    },
  });
  const driver = new DirectDeepSeekResponsesModelDriverForTesting({
    apiKey: "test-secret",
    baseURL: "https://api.deepseek.com",
    maximumOutputTokens: 4_096,
    model: "deepseek-v4-flash-vision-exp",
    fetch: async () => new Response(body, { status: 200 }),
  });

  for await (const event of driver.stream({
    messages: [{ role: "user", content: "return early" }],
    tools: [],
    maximumOutputTokens: 2_048,
    signal: new AbortController().signal,
  })) {
    expect(event).toEqual({ type: "text_delta", text: "enough" });
    break;
  }
  await expect(cancelled.promise).resolves.toBeUndefined();
});

test("Direct Responses classifies bounded provider errors without retaining its credential", async () => {
  const driver = new DirectDeepSeekResponsesModelDriverForTesting({
    apiKey: "test-secret",
    baseURL: "https://api.deepseek.com",
    maximumOutputTokens: 4_096,
    model: "deepseek-v4-flash-vision-exp",
    fetch: async () =>
      Response.json(
        { error: { code: "billing_error", message: "balance test-secret" } },
        { status: 402, headers: { "x-request-id": "request-test-secret" } },
      ),
  });
  const error = await collectError(
    driver.stream({
      messages: [{ role: "user", content: "fail" }],
      tools: [],
      maximumOutputTokens: 2_048,
      signal: new AbortController().signal,
    }),
  );

  expect(error).toMatchObject({
    category: "billing",
    status: 402,
    providerCode: "billing_error",
    requestId: "request-[REDACTED]",
    responseSummary: "balance [REDACTED]",
  });
  expect(JSON.stringify(error)).not.toContain("test-secret");
});

test("Direct Responses cancels an oversized provider error body", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(256 * 1024 + 1));
    },
    cancel,
  });
  const driver = new DirectDeepSeekResponsesModelDriverForTesting({
    apiKey: "test-secret",
    baseURL: "https://api.deepseek.com",
    maximumOutputTokens: 4_096,
    model: "deepseek-v4-flash-vision-exp",
    fetch: async () => new Response(body, { status: 500 }),
  });

  await expect(
    collectError(
      driver.stream({
        messages: [{ role: "user", content: "bound provider error" }],
        tools: [],
        maximumOutputTokens: 2_048,
        signal: new AbortController().signal,
      }),
    ),
  ).resolves.toMatchObject({ category: "protocol_incompatibility" });
  expect(cancel).toHaveBeenCalledOnce();
});

test("Direct Responses maps semantic incomplete terminal truth", async () => {
  const incomplete = new DirectDeepSeekResponsesModelDriverForTesting({
    apiKey: "test-secret",
    baseURL: "https://api.deepseek.com",
    maximumOutputTokens: 4_096,
    model: "deepseek-v4-flash-vision-exp",
    fetch: async () =>
      new Response(
        'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"content_filter"}}}\n\n',
        { status: 200 },
      ),
  });
  const events = [];
  for await (const event of incomplete.stream({
    messages: [{ role: "user", content: "incomplete" }],
    tools: [],
    maximumOutputTokens: 2_048,
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  expect(events).toEqual([
    { type: "finish", reason: "content_filter", rawReason: "content_filter" },
  ]);
});

test("Direct Responses maps semantic failed terminal truth", async () => {
  const failed = new DirectDeepSeekResponsesModelDriverForTesting({
    apiKey: "test-secret",
    baseURL: "https://api.deepseek.com",
    maximumOutputTokens: 4_096,
    model: "deepseek-v4-flash-vision-exp",
    fetch: async () =>
      new Response(
        'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"provider_failure","message":"failed test-secret"}}}\n\n',
        { status: 200 },
      ),
  });
  await expect(
    collectError(
      failed.stream({
        messages: [{ role: "user", content: "fail" }],
        tools: [],
        maximumOutputTokens: 2_048,
        signal: new AbortController().signal,
      }),
    ),
  ).resolves.toMatchObject({
    category: "provider",
    providerCode: "provider_failure",
    responseSummary: "failed [REDACTED]",
  });
});

async function collectError(stream: AsyncIterable<unknown>): Promise<ModelDriverError> {
  try {
    for await (const _event of stream) {
      // Consume until failure.
    }
  } catch (error) {
    if (error instanceof ModelDriverError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the model driver to fail.");
}
