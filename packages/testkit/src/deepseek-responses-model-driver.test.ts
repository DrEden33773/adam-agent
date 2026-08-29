import type { ModelRequest } from "@adam-agent/agent";
import { DirectDeepSeekResponsesModelDriverForTesting } from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";

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
