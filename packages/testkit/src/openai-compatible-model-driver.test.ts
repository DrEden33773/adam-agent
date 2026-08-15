import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentSession,
  createInMemorySessionStore,
  createPermissionPolicy,
  createReadToolRegistry,
  ModelDriverError,
  type ModelEvent,
  OpenAICompatibleModelDriver,
} from "@adam-agent/agent";
import { describe, expect, test, vi } from "vitest";

describe("OpenAICompatibleModelDriver", () => {
  test("normalizes one answer-only DeepSeek SSE stream", async () => {
    const requests: Array<{ readonly url: string; readonly body: unknown }> = [];
    const driver = new OpenAICompatibleModelDriver({
      profile: "deepseek",
      apiKey: "test-deepseek-key",
      baseURL: "https://deepseek.invalid",
      model: "deepseek-test",
      maximumOutputTokens: 4_096,
      fetch: async (input, init) => {
        requests.push({
          url: input instanceof Request ? input.url : String(input),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(answerOnlyStream, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        });
      },
    });

    const events = await collect(
      driver.stream({
        messages: [{ role: "user", content: "Introduce yourself" }],
        tools: [],
        signal: new AbortController().signal,
      }),
    );

    expect({ requests, events }).toEqual({
      requests: [
        {
          url: "https://deepseek.invalid/chat/completions",
          body: {
            messages: [{ role: "user", content: "Introduce yourself" }],
            model: "deepseek-test",
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: 4_096,
          },
        },
      ],
      events: [
        { type: "text_delta", text: "Hello, " },
        { type: "text_delta", text: "Adam." },
        {
          type: "usage",
          inputTokens: 7,
          outputTokens: 3,
          reasoningTokens: 1,
          cachedInputTokens: 2,
          cacheMissInputTokens: 5,
        },
        { type: "finish", reason: "stop", rawReason: "stop" },
      ],
    });
  });

  test("settles explicitly when DeepSeek reaches its output limit", async () => {
    const store = createInMemorySessionStore();
    const session = new AgentSession({
      model: new OpenAICompatibleModelDriver({
        profile: "deepseek",
        apiKey: "test-deepseek-key",
        baseURL: "https://deepseek.invalid",
        model: "deepseek-test",
        maximumOutputTokens: 4_096,
        fetch: async () =>
          new Response(lengthLimitedStream, {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          }),
      }),
      store,
    });

    const result = await session.run({ text: "Write a long answer" });
    const records = await store.read();

    expect({ result, settled: records.at(-1)?.event }).toEqual({
      result: {
        status: "failed",
        error: {
          code: "model_output_truncated",
          message: "The model response reached its output-token limit.",
        },
      },
      settled: {
        type: "session_settled",
        result: {
          status: "failed",
          error: {
            code: "model_output_truncated",
            message: "The model response reached its output-token limit.",
          },
        },
      },
    });
  });

  test("settles explicitly when DeepSeek filters the response", async () => {
    const store = createInMemorySessionStore();
    const session = new AgentSession({
      model: new OpenAICompatibleModelDriver({
        profile: "deepseek",
        apiKey: "test-deepseek-key",
        baseURL: "https://deepseek.invalid",
        model: "deepseek-test",
        maximumOutputTokens: 4_096,
        fetch: async () =>
          new Response(contentFilteredStream, {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          }),
      }),
      store,
    });

    const result = await session.run({ text: "Answer the request" });

    expect(result).toEqual({
      status: "failed",
      error: {
        code: "model_content_filtered",
        message: "The provider filtered the model response.",
      },
    });
  });

  test("settles explicitly when DeepSeek reports insufficient system resources", async () => {
    const store = createInMemorySessionStore();
    const session = new AgentSession({
      model: new OpenAICompatibleModelDriver({
        profile: "deepseek",
        apiKey: "test-deepseek-key",
        baseURL: "https://deepseek.invalid",
        model: "deepseek-test",
        maximumOutputTokens: 4_096,
        fetch: async () =>
          new Response(resourceExhaustedStream, {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          }),
      }),
      store,
    });

    const result = await session.run({ text: "Answer the request" });

    expect(result).toEqual({
      status: "failed",
      error: {
        code: "model_resource_exhausted",
        message:
          "The provider could not complete the model response because resources were unavailable.",
        providerReason: "insufficient_system_resource",
      },
    });
  });

  test("settles explicitly and retains an unknown provider finish reason", async () => {
    const store = createInMemorySessionStore();
    const session = new AgentSession({
      model: new OpenAICompatibleModelDriver({
        profile: "deepseek",
        apiKey: "test-deepseek-key",
        baseURL: "https://deepseek.invalid",
        model: "deepseek-test",
        maximumOutputTokens: 4_096,
        fetch: async () =>
          new Response(unknownFinishStream, {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          }),
      }),
      store,
    });

    const result = await session.run({ text: "Answer the request" });

    expect(result).toEqual({
      status: "failed",
      error: {
        code: "model_finish_unknown",
        message: "The provider ended the model response for an unknown reason.",
        providerReason: "future_provider_reason",
      },
    });
  });

  test("bounds an unknown provider finish reason before persistence", async () => {
    const rawReason = "x".repeat(200);
    const store = createInMemorySessionStore();
    const session = new AgentSession({
      model: new OpenAICompatibleModelDriver({
        profile: "deepseek",
        apiKey: "test-key",
        baseURL: "https://deepseek.invalid",
        model: "deepseek-test",
        maximumOutputTokens: 4_096,
        fetch: async () =>
          new Response(
            `data: ${JSON.stringify({
              id: "bounded-finish-1",
              choices: [{ index: 0, delta: {}, finish_reason: rawReason }],
              created: 1,
              model: "deepseek-test",
              object: "chat.completion.chunk",
            })}\n\ndata: [DONE]\n\n`,
            {
              headers: { "content-type": "text/event-stream" },
              status: 200,
            },
          ),
      }),
      store,
    });

    const result = await session.run({ text: "Answer" });

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "model_finish_unknown",
        providerReason: "x".repeat(128),
      },
    });
  });

  test("rejects invalid detailed usage as a model protocol failure", async () => {
    const session = new AgentSession({
      model: new OpenAICompatibleModelDriver({
        profile: "deepseek",
        apiKey: "test-key",
        baseURL: "https://deepseek.invalid",
        model: "deepseek-test",
        maximumOutputTokens: 4_096,
        fetch: async () =>
          new Response(invalidDetailedUsageStream, {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          }),
      }),
      store: createInMemorySessionStore(),
    });

    const result = await session.run({ text: "Answer" });

    expect(result).toEqual({
      status: "failed",
      error: {
        code: "model_protocol_invalid",
        message: "The model reported invalid token usage.",
      },
    });
  });

  test("classifies a DeepSeek authentication response as an Adam-owned error", async () => {
    const driver = new OpenAICompatibleModelDriver({
      profile: "deepseek",
      apiKey: "invalid-test-key",
      baseURL: "https://deepseek.invalid",
      model: "deepseek-test",
      maximumOutputTokens: 4_096,
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "Authentication failed",
              type: "authentication_error",
              code: "invalid_api_key",
            },
          }),
          {
            headers: {
              "content-type": "application/json",
              "x-request-id": "request-auth-1",
            },
            status: 401,
          },
        ),
    });

    let thrown: unknown;
    try {
      await collect(
        driver.stream({
          messages: [{ role: "user", content: "Hello" }],
          tools: [],
          signal: new AbortController().signal,
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ModelDriverError);
    expect(thrown).toMatchObject({
      category: "authentication",
      status: 401,
      providerCode: "invalid_api_key",
      requestId: "request-auth-1",
      responseSummary: "Authentication failed",
    });
  });

  test("persists only bounded Adam metadata for a provider failure", async () => {
    const store = createInMemorySessionStore();
    const session = new AgentSession({
      model: new OpenAICompatibleModelDriver({
        profile: "deepseek",
        apiKey: "never-persist-this-test-key",
        baseURL: "https://deepseek.invalid",
        model: "deepseek-test",
        maximumOutputTokens: 4_096,
        fetch: async () =>
          new Response(
            JSON.stringify({
              error: {
                message:
                  "Authentication failed for never-persist-this-test-key; repository token is private-repository-token",
                type: "authentication_error",
                code: "invalid-never-persist-this-test-key",
              },
            }),
            {
              headers: {
                "content-type": "application/json",
                "x-request-id": "request-never-persist-this-test-key",
              },
              status: 401,
            },
          ),
      }),
      store,
    });

    const result = await session.run({ text: "Hello" });
    const persisted = JSON.stringify(await store.read());

    expect(result).toEqual({
      status: "failed",
      error: {
        code: "model_request_failed",
        message: "The model provider rejected authentication.",
        category: "authentication",
        status: 401,
        providerCode: "invalid-[REDACTED]",
        requestId: "request-[REDACTED]",
      },
    });
    expect(persisted).not.toContain("never-persist-this-test-key");
    expect(persisted).not.toContain("private-repository-token");
    expect(persisted).not.toContain("AuthenticationError");
  });

  test("classifies a DeepSeek authorization response", async () => {
    const error = await collectDriverError(403, {
      message: "Access denied",
      type: "permission_error",
      code: "permission_denied",
    });

    expect(error).toMatchObject({
      category: "authorization",
      status: 403,
      providerCode: "permission_denied",
      responseSummary: "Access denied",
    });
  });

  test("classifies a DeepSeek rate-limit response", async () => {
    const error = await collectDriverError(429, {
      message: "Too many requests",
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
    });

    expect(error).toMatchObject({
      category: "rate_limit",
      status: 429,
      providerCode: "rate_limit_exceeded",
      responseSummary: "Too many requests",
    });
  });

  test("classifies a DeepSeek invalid-request response", async () => {
    const error = await collectDriverError(400, {
      message: "Invalid request",
      type: "invalid_request_error",
      code: "invalid_request",
    });

    expect(error).toMatchObject({
      category: "invalid_request",
      status: 400,
      providerCode: "invalid_request",
      responseSummary: "Invalid request",
    });
  });

  test("classifies a DeepSeek server response", async () => {
    const error = await collectDriverError(503, {
      message: "Service unavailable",
      type: "server_error",
      code: "service_unavailable",
    });

    expect(error).toMatchObject({
      category: "provider",
      status: 503,
      providerCode: "service_unavailable",
      responseSummary: "Service unavailable",
    });
  });

  test("retains bounded metadata for an unrecognized provider response", async () => {
    const error = await collectDriverError(418, {
      message: "Unexpected provider response",
      type: "future_error",
      code: "future_error_code",
    });

    expect(error).toMatchObject({
      category: "unknown",
      status: 418,
      providerCode: "future_error_code",
      responseSummary: "Unexpected provider response",
    });
  });

  test("classifies one transport failure without a hidden retry", async () => {
    let attempts = 0;
    const driver = new OpenAICompatibleModelDriver({
      profile: "deepseek",
      apiKey: "test-key",
      baseURL: "https://deepseek.invalid",
      model: "deepseek-test",
      maximumOutputTokens: 4_096,
      fetch: async () => {
        attempts += 1;
        throw new TypeError("socket disconnected");
      },
    });

    const error = await captureDriverError(driver);

    expect({ error, attempts }).toMatchObject({
      error: { category: "transport" },
      attempts: 1,
    });
  });

  test("classifies malformed provider SSE as a protocol incompatibility", async () => {
    const driver = new OpenAICompatibleModelDriver({
      profile: "deepseek",
      apiKey: "test-key",
      baseURL: "https://deepseek.invalid",
      model: "deepseek-test",
      maximumOutputTokens: 4_096,
      fetch: async () =>
        new Response('data: {"invalid":\n\n', {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        }),
    });

    const error = await captureDriverError(driver);

    expect(error).toMatchObject({ category: "protocol_incompatibility" });
  });

  test("classifies an invalid provider chunk shape as a protocol incompatibility", async () => {
    const driver = new OpenAICompatibleModelDriver({
      profile: "deepseek",
      apiKey: "test-key",
      baseURL: "https://deepseek.invalid",
      model: "deepseek-test",
      maximumOutputTokens: 4_096,
      fetch: async () =>
        new Response(
          'data: {"id":"invalid-1","choices":null,"created":1,"model":"deepseek-test","object":"chat.completion.chunk"}\n\n',
          {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          },
        ),
    });

    const error = await captureDriverError(driver);

    expect(error).toMatchObject({ category: "protocol_incompatibility" });
  });

  test("rejects multiple provider choices instead of merging them", async () => {
    const driver = new OpenAICompatibleModelDriver({
      profile: "deepseek",
      apiKey: "test-key",
      baseURL: "https://deepseek.invalid",
      model: "deepseek-test",
      maximumOutputTokens: 4_096,
      fetch: async () =>
        new Response(
          'data: {"id":"multiple-choices-1","choices":[{"index":0,"delta":{"content":"First"},"finish_reason":"stop"},{"index":1,"delta":{"content":"Second"},"finish_reason":"stop"}],"created":1,"model":"deepseek-test","object":"chat.completion.chunk"}\n\n',
          {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          },
        ),
    });

    const error = await captureDriverError(driver);

    expect(error).toMatchObject({
      category: "protocol_incompatibility",
      message: "The model provider returned an invalid choice payload.",
    });
  });

  test("rejects a non-string provider content delta", async () => {
    const driver = new OpenAICompatibleModelDriver({
      profile: "deepseek",
      apiKey: "test-key",
      baseURL: "https://deepseek.invalid",
      model: "deepseek-test",
      maximumOutputTokens: 4_096,
      fetch: async () =>
        new Response(
          'data: {"id":"invalid-content-1","choices":[{"index":0,"delta":{"content":42},"finish_reason":"stop"}],"created":1,"model":"deepseek-test","object":"chat.completion.chunk"}\n\n',
          {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          },
        ),
    });

    const error = await captureDriverError(driver);

    expect(error).toMatchObject({
      category: "protocol_incompatibility",
      message: "The model provider returned an invalid choice payload.",
    });
  });

  test("rejects normalized text that exceeds Adam's stream limit", async () => {
    const oversizedText = "x".repeat(512 * 1024 + 1);
    const driver = new OpenAICompatibleModelDriver({
      profile: "deepseek",
      apiKey: "test-key",
      baseURL: "https://deepseek.invalid",
      model: "deepseek-test",
      maximumOutputTokens: 4_096,
      fetch: async () =>
        new Response(
          `data: ${JSON.stringify({
            id: "oversized-text-1",
            choices: [{ index: 0, delta: { content: oversizedText }, finish_reason: "stop" }],
            created: 1,
            model: "deepseek-test",
            object: "chat.completion.chunk",
          })}\n\n`,
          {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          },
        ),
    });

    const error = await captureDriverError(driver);

    expect(error).toMatchObject({
      category: "protocol_incompatibility",
      message: "The model provider response exceeded Adam's stream limit.",
    });
  });

  test("settles a truncated provider stream without completing partial text", async () => {
    const store = createInMemorySessionStore();
    const session = new AgentSession({
      model: new OpenAICompatibleModelDriver({
        profile: "deepseek",
        apiKey: "test-key",
        baseURL: "https://deepseek.invalid",
        model: "deepseek-test",
        maximumOutputTokens: 4_096,
        fetch: async () =>
          new Response(
            'data: {"id":"truncated-1","choices":[{"index":0,"delta":{"content":"Partial"},"finish_reason":null}],"created":1,"model":"deepseek-test","object":"chat.completion.chunk"}\n\n',
            {
              headers: { "content-type": "text/event-stream" },
              status: 200,
            },
          ),
      }),
      store,
    });

    const result = await session.run({ text: "Answer" });
    const events = (await store.read()).map((record) => record.event);

    expect({
      result,
      completed: events.some((event) => event.type === "model_message_completed"),
    }).toEqual({
      result: {
        status: "failed",
        error: {
          code: "model_stream_incomplete",
          message: "The model stream ended without a finish event.",
        },
      },
      completed: false,
    });
  });

  test("classifies an already-aborted provider request", async () => {
    const controller = new AbortController();
    controller.abort();
    const driver = new OpenAICompatibleModelDriver({
      profile: "deepseek",
      apiKey: "test-key",
      baseURL: "https://deepseek.invalid",
      model: "deepseek-test",
      maximumOutputTokens: 4_096,
      fetch: async () => {
        throw new Error("The transport must not start for an aborted request.");
      },
    });

    const error = await captureDriverError(driver, controller.signal);

    expect(error).toMatchObject({ category: "aborted" });
  });

  test("caller cancellation wins during a live provider stream and settles once", async () => {
    const caller = new AbortController();
    const store = createInMemorySessionStore();
    const session = new AgentSession({
      model: new OpenAICompatibleModelDriver({
        profile: "deepseek",
        apiKey: "test-key",
        baseURL: "https://deepseek.invalid",
        model: "deepseek-test",
        maximumOutputTokens: 4_096,
        fetch: async (_input, init) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(streamController) {
                streamController.enqueue(
                  new TextEncoder().encode(
                    'data: {"id":"cancel-1","choices":[{"index":0,"delta":{"content":"Partial"},"finish_reason":null}],"created":1,"model":"deepseek-test","object":"chat.completion.chunk"}\n\n',
                  ),
                );
                init?.signal?.addEventListener(
                  "abort",
                  () => streamController.error(init.signal?.reason),
                  { once: true },
                );
              },
            }),
            {
              headers: { "content-type": "text/event-stream" },
              status: 200,
            },
          ),
      }),
      store,
    });
    const events: Array<{ readonly type: string }> = [];
    let resolveDelta: (() => void) | undefined;
    const sawDelta = new Promise<void>((resolve) => {
      resolveDelta = resolve;
    });
    session.subscribe((event) => {
      events.push(event);
      if (event.type === "model_message_delta") {
        resolveDelta?.();
      }
    });

    const running = session.run({ text: "Answer" }, { signal: caller.signal });
    await sawDelta;
    caller.abort();
    const result = await running;

    expect({
      result,
      settled: events.filter((event) => event.type === "session_settled").length,
      completed: events.some((event) => event.type === "model_message_completed"),
    }).toEqual({
      result: {
        status: "cancelled",
        error: { code: "session_cancelled", message: "The session was cancelled." },
      },
      settled: 1,
      completed: false,
    });
  });

  test("a full-stream deadline settles as timeout and cannot later publish success", async () => {
    vi.useFakeTimers();
    const cleanup = new AbortController();
    const store = createInMemorySessionStore();
    const events: Array<{ readonly type: string }> = [];
    let bodyWasAborted = false;
    let resolveDelta: (() => void) | undefined;
    const sawDelta = new Promise<void>((resolve) => {
      resolveDelta = resolve;
    });
    const session = new AgentSession({
      model: new OpenAICompatibleModelDriver({
        profile: "deepseek",
        apiKey: "test-key",
        baseURL: "https://deepseek.invalid",
        model: "deepseek-test",
        maximumOutputTokens: 4_096,
        deadlineMs: 50,
        fetch: async (_input, init) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(streamController) {
                streamController.enqueue(
                  new TextEncoder().encode(
                    'data: {"id":"deadline-1","choices":[{"index":0,"delta":{"content":"Partial"},"finish_reason":null}],"created":1,"model":"deepseek-test","object":"chat.completion.chunk"}\n\n',
                  ),
                );
                init?.signal?.addEventListener(
                  "abort",
                  () => {
                    bodyWasAborted = true;
                    streamController.error(init.signal?.reason);
                  },
                  { once: true },
                );
              },
            }),
            {
              headers: { "content-type": "text/event-stream" },
              status: 200,
            },
          ),
      }),
      store,
    });
    session.subscribe((event) => {
      events.push(event);
      if (event.type === "model_message_delta") {
        resolveDelta?.();
      }
    });

    try {
      const running = session.run({ text: "Answer" }, { signal: cleanup.signal });
      await sawDelta;
      await vi.advanceTimersByTimeAsync(50);
      const result = await Promise.race([running, Promise.resolve("deadline-did-not-settle")]);
      if (result === "deadline-did-not-settle") {
        cleanup.abort();
        await running;
      }

      expect({
        result,
        bodyWasAborted,
        settled: events.filter((event) => event.type === "session_settled").length,
        completed: events.some((event) => event.type === "model_message_completed"),
      }).toEqual({
        result: {
          status: "failed",
          error: {
            code: "model_request_failed",
            message: "The model provider request reached its deadline.",
            category: "timeout",
          },
        },
        bodyWasAborted: true,
        settled: 1,
        completed: false,
      });
    } finally {
      cleanup.abort();
      vi.useRealTimers();
    }
  });

  test("maps Adam messages and tools into one DeepSeek request", async () => {
    const requests: unknown[] = [];
    const driver = new OpenAICompatibleModelDriver({
      profile: "deepseek",
      apiKey: "test-deepseek-key",
      baseURL: "https://deepseek.invalid",
      model: "deepseek-test",
      maximumOutputTokens: 4_096,
      fetch: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(answerOnlyStream, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        });
      },
    });

    await collect(
      driver.stream({
        messages: [
          { role: "system", content: "Follow the platform rules." },
          { role: "developer", content: "Work only inside the repository." },
          { role: "user", content: "Read the project name." },
          {
            role: "assistant",
            content: "I will read it.",
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

    expect(requests).toEqual([
      {
        messages: [
          { role: "system", content: "Follow the platform rules." },
          {
            role: "system",
            content: "Developer instruction:\nWork only inside the repository.",
          },
          { role: "user", content: "Read the project name." },
          {
            role: "assistant",
            content: "I will read it.",
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
        model: "deepseek-test",
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 4_096,
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "Read a UTF-8 text file inside the workspace.",
              parameters: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
                additionalProperties: false,
              },
            },
          },
        ],
      },
    ]);
  });

  test("normalizes interleaved fragmented tool calls in stable index order", async () => {
    const driver = new OpenAICompatibleModelDriver({
      profile: "deepseek",
      apiKey: "test-deepseek-key",
      baseURL: "https://deepseek.invalid",
      model: "deepseek-test",
      maximumOutputTokens: 4_096,
      fetch: async () =>
        new Response(interleavedToolStream, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        }),
    });

    const events = await collect(
      driver.stream({
        messages: [{ role: "user", content: "Read the README and print the directory." }],
        tools: [],
        signal: new AbortController().signal,
      }),
    );

    expect(events).toEqual([
      { type: "tool_call_start", id: "read-project", name: "read_file" },
      { type: "tool_call_delta", id: "read-project", json: '{"pa' },
      { type: "tool_call_delta", id: "read-project", json: 'th":"README.md"}' },
      { type: "tool_call_end", id: "read-project" },
      { type: "tool_call_start", id: "run-directory", name: "run_shell" },
      { type: "tool_call_delta", id: "run-directory", json: '{"com' },
      { type: "tool_call_delta", id: "run-directory", json: 'mand":"pwd"}' },
      { type: "tool_call_end", id: "run-directory" },
      { type: "usage", inputTokens: 11, outputTokens: 8 },
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls" },
    ]);
  });

  test("preserves a raw tool argument above the normalized patch limit", async () => {
    const argumentsJson = `${JSON.stringify({ operations: [] })}${" ".repeat(520 * 1024)}`;
    const driver = new OpenAICompatibleModelDriver({
      profile: "deepseek",
      apiKey: "test-key",
      baseURL: "https://deepseek.invalid",
      model: "deepseek-test",
      maximumOutputTokens: 4_096,
      fetch: async () =>
        new Response(
          `data: ${JSON.stringify({
            id: "raw-patch-arguments-1",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "patch-repository",
                      type: "function",
                      function: { name: "edit_file", arguments: argumentsJson },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            created: 1,
            model: "deepseek-test",
            object: "chat.completion.chunk",
          })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" }, status: 200 },
        ),
    });

    const events = await collect(
      driver.stream({
        messages: [{ role: "user", content: "Apply the patch" }],
        tools: [],
        signal: new AbortController().signal,
      }),
    );
    const argumentDelta = events.find((event) => event.type === "tool_call_delta");

    expect({
      eventTypes: events.map((event) => event.type),
      argumentBytes:
        argumentDelta?.type === "tool_call_delta"
          ? Buffer.byteLength(argumentDelta.json, "utf8")
          : undefined,
    }).toEqual({
      eventTypes: ["tool_call_start", "tool_call_delta", "tool_call_end", "finish"],
      argumentBytes: Buffer.byteLength(argumentsJson, "utf8"),
    });
  });

  test("rejects aggregate raw tool arguments above the transport limit", async () => {
    const argumentsJson = `${JSON.stringify({ operations: [] })}${" ".repeat(2 * 1024 * 1024)}`;
    const driver = new OpenAICompatibleModelDriver({
      profile: "deepseek",
      apiKey: "test-key",
      baseURL: "https://deepseek.invalid",
      model: "deepseek-test",
      maximumOutputTokens: 4_096,
      fetch: async () =>
        new Response(
          `data: ${JSON.stringify({
            id: "oversized-raw-patch-arguments-1",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "patch-repository",
                      type: "function",
                      function: { name: "edit_file", arguments: argumentsJson },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            created: 1,
            model: "deepseek-test",
            object: "chat.completion.chunk",
          })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" }, status: 200 },
        ),
    });

    const error = await captureDriverError(driver);

    expect(error).toMatchObject({
      category: "protocol_incompatibility",
      message: "The model provider response exceeded Adam's stream limit.",
    });
  });

  test("rejects one incomplete parallel tool call before any valid call executes", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-provider-incomplete-tool-"));
    const events: Array<{ readonly type: string }> = [];
    try {
      await writeFile(join(workspaceRoot, "README.md"), "# Adam Agent\n", "utf8");
      const session = new AgentSession({
        model: new OpenAICompatibleModelDriver({
          profile: "deepseek",
          apiKey: "test-key",
          baseURL: "https://deepseek.invalid",
          model: "deepseek-test",
          maximumOutputTokens: 4_096,
          fetch: async () =>
            new Response(incompleteParallelToolStream, {
              headers: { "content-type": "text/event-stream" },
              status: 200,
            }),
        }),
        store: createInMemorySessionStore(),
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });
      session.subscribe((event) => events.push(event));

      const result = await session.run({ text: "Read the README" }, { limits: { maxTurns: 1 } });

      expect({
        result,
        toolStarted: events.some((event) => event.type === "tool_started"),
      }).toEqual({
        result: {
          status: "failed",
          error: {
            code: "model_request_failed",
            message: "The model provider returned an incomplete tool call.",
            category: "protocol_incompatibility",
          },
        },
        toolStarted: false,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("replays reasoning across one real read tool turn without persisting it", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-provider-reasoning-"));
    const responses = [reasoningToolStream, finalAnswerStream];
    const requests: Array<{ readonly messages: readonly unknown[] }> = [];
    const store = createInMemorySessionStore();

    try {
      await writeFile(join(workspaceRoot, "README.md"), "# Adam Agent\n", "utf8");
      const driver = new OpenAICompatibleModelDriver({
        profile: "deepseek",
        apiKey: "test-deepseek-key",
        baseURL: "https://deepseek.invalid",
        model: "deepseek-test",
        maximumOutputTokens: 4_096,
        fetch: async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as {
            readonly messages: readonly unknown[];
          };
          requests.push({ messages: body.messages });
          const response = responses.shift();
          if (response === undefined) {
            throw new Error("The provider received an unexpected request.");
          }
          return new Response(response, {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          });
        },
      });
      const session = new AgentSession({
        model: driver,
        store,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });

      const result = await session.run({ text: "What is the project name?" });
      const records = await store.read();

      expect({
        result,
        secondRequestMessages: requests[1]?.messages,
        persistedReasoning: JSON.stringify(records).includes("I need the README."),
      }).toEqual({
        result: { status: "completed", answer: "The project is Adam Agent." },
        secondRequestMessages: [
          { role: "user", content: "What is the project name?" },
          {
            role: "assistant",
            content: "",
            reasoning_content: "I need the README.",
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
        persistedReasoning: false,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

async function collect(events: AsyncIterable<ModelEvent>): Promise<readonly ModelEvent[]> {
  const collected: ModelEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

async function collectDriverError(
  status: number,
  providerError: { readonly message: string; readonly type: string; readonly code: string },
): Promise<ModelDriverError> {
  const driver = new OpenAICompatibleModelDriver({
    profile: "deepseek",
    apiKey: "test-key",
    baseURL: "https://deepseek.invalid",
    model: "deepseek-test",
    maximumOutputTokens: 4_096,
    fetch: async () =>
      new Response(JSON.stringify({ error: providerError }), {
        headers: { "content-type": "application/json" },
        status,
      }),
  });
  return captureDriverError(driver);
}

async function captureDriverError(
  driver: OpenAICompatibleModelDriver,
  signal = new AbortController().signal,
): Promise<ModelDriverError> {
  try {
    await collect(
      driver.stream({
        messages: [{ role: "user", content: "Hello" }],
        tools: [],
        signal,
      }),
    );
  } catch (error) {
    if (error instanceof ModelDriverError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the model driver to fail.");
}

const answerOnlyStream = [
  'data: {"id":"answer-1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello, "},"finish_reason":null}],"created":1,"model":"deepseek-test","object":"chat.completion.chunk","usage":null}',
  "",
  'data: {"id":"answer-1","choices":[{"index":0,"delta":{"content":"Adam."},"finish_reason":null}],"created":1,"model":"deepseek-test","object":"chat.completion.chunk","usage":null}',
  "",
  'data: {"id":"answer-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"created":1,"model":"deepseek-test","object":"chat.completion.chunk","usage":null}',
  "",
  'data: {"id":"answer-1","choices":[],"created":1,"model":"deepseek-test","object":"chat.completion.chunk","usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10,"prompt_cache_hit_tokens":2,"prompt_cache_miss_tokens":5,"completion_tokens_details":{"reasoning_tokens":1}}}',
  "",
  "data: [DONE]",
  "",
].join("\n");

const lengthLimitedStream = [
  'data: {"id":"length-1","choices":[{"index":0,"delta":{"role":"assistant","content":"Partial"},"finish_reason":null}],"created":1,"model":"deepseek-test","object":"chat.completion.chunk","usage":null}',
  "",
  'data: {"id":"length-1","choices":[{"index":0,"delta":{},"finish_reason":"length"}],"created":1,"model":"deepseek-test","object":"chat.completion.chunk","usage":null}',
  "",
  "data: [DONE]",
  "",
].join("\n");

const contentFilteredStream = [
  'data: {"id":"filter-1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":"content_filter"}],"created":1,"model":"deepseek-test","object":"chat.completion.chunk","usage":null}',
  "",
  "data: [DONE]",
  "",
].join("\n");

const resourceExhaustedStream = [
  'data: {"id":"resource-1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":"insufficient_system_resource"}],"created":1,"model":"deepseek-test","object":"chat.completion.chunk","usage":null}',
  "",
  "data: [DONE]",
  "",
].join("\n");

const unknownFinishStream = [
  'data: {"id":"unknown-1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":"future_provider_reason"}],"created":1,"model":"deepseek-test","object":"chat.completion.chunk","usage":null}',
  "",
  "data: [DONE]",
  "",
].join("\n");

const invalidDetailedUsageStream = [
  'data: {"id":"usage-invalid-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"created":1,"model":"deepseek-test","object":"chat.completion.chunk","usage":null}',
  "",
  'data: {"id":"usage-invalid-1","choices":[],"created":1,"model":"deepseek-test","object":"chat.completion.chunk","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"completion_tokens_details":{"reasoning_tokens":-1}}}',
  "",
  "data: [DONE]",
  "",
].join("\n");

const interleavedToolStream = [
  'data: {"id":"tools-1","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"read-project","type":"function","function":{"name":"read_","arguments":"{\\"pa"}},{"index":1,"id":"run-directory","type":"function","function":{"name":"run_","arguments":"{\\"com"}}]},"finish_reason":null}],"created":1,"model":"deepseek-test","object":"chat.completion.chunk","usage":null}',
  "",
  'data: {"id":"tools-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"name":"shell","arguments":"mand\\":\\"pwd\\"}"}},{"index":0,"function":{"name":"file","arguments":"th\\":\\"README.md\\"}"}}]},"finish_reason":null}],"created":1,"model":"deepseek-test","object":"chat.completion.chunk","usage":null}',
  "",
  'data: {"id":"tools-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"created":1,"model":"deepseek-test","object":"chat.completion.chunk","usage":null}',
  "",
  'data: {"id":"tools-1","choices":[],"created":1,"model":"deepseek-test","object":"chat.completion.chunk","usage":{"prompt_tokens":11,"completion_tokens":8,"total_tokens":19}}',
  "",
  "data: [DONE]",
  "",
].join("\n");

const incompleteParallelToolStream = [
  'data: {"id":"incomplete-tool-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"read-project","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}},{"index":1,"type":"function","function":{"arguments":"{}"}}]},"finish_reason":null}],"created":1,"model":"deepseek-test","object":"chat.completion.chunk","usage":null}',
  "",
  'data: {"id":"incomplete-tool-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"created":1,"model":"deepseek-test","object":"chat.completion.chunk","usage":null}',
  "",
  "data: [DONE]",
  "",
].join("\n");

const reasoningToolStream = [
  'data: {"id":"reasoning-1","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"I need "},"finish_reason":null}],"created":1,"model":"deepseek-test","object":"chat.completion.chunk","usage":null}',
  "",
  'data: {"id":"reasoning-1","choices":[{"index":0,"delta":{"reasoning_content":"the README."},"finish_reason":null}],"created":1,"model":"deepseek-test","object":"chat.completion.chunk","usage":null}',
  "",
  'data: {"id":"reasoning-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"read-project","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}]},"finish_reason":null}],"created":1,"model":"deepseek-test","object":"chat.completion.chunk","usage":null}',
  "",
  'data: {"id":"reasoning-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"created":1,"model":"deepseek-test","object":"chat.completion.chunk","usage":null}',
  "",
  'data: {"id":"reasoning-1","choices":[],"created":1,"model":"deepseek-test","object":"chat.completion.chunk","usage":{"prompt_tokens":13,"completion_tokens":9,"total_tokens":22}}',
  "",
  "data: [DONE]",
  "",
].join("\n");

const finalAnswerStream = [
  'data: {"id":"answer-2","choices":[{"index":0,"delta":{"role":"assistant","content":"The project is Adam Agent."},"finish_reason":null}],"created":2,"model":"deepseek-test","object":"chat.completion.chunk","usage":null}',
  "",
  'data: {"id":"answer-2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"created":2,"model":"deepseek-test","object":"chat.completion.chunk","usage":null}',
  "",
  'data: {"id":"answer-2","choices":[],"created":2,"model":"deepseek-test","object":"chat.completion.chunk","usage":{"prompt_tokens":21,"completion_tokens":6,"total_tokens":27}}',
  "",
  "data: [DONE]",
  "",
].join("\n");
