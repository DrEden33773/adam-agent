import { appendFile, writeFile } from "node:fs/promises";

const { ADAM_TEST_TERMINAL_PROCESS_MARKER: marker } = process.env;
if (marker === undefined) {
  throw new TypeError("The production TUI fixture requires its process marker.");
}
await writeFile(marker, `${process.pid}\n`, "utf8");
// biome-ignore lint/complexity/useLiteralKeys: ProcessEnv requires indexed access under strict TypeScript.
const modelResponse = process.env["ADAM_TEST_MODEL_RESPONSE"];
if (modelResponse !== undefined) {
  globalThis.fetch = async (_input, init) => {
    const { ADAM_TEST_REVIEW_REQUEST_MARKER: requestMarker, ADAM_TEST_REVIEW_STREAM: streaming } =
      process.env;
    if (requestMarker !== undefined) await appendFile(requestMarker, "request\n");
    if (streaming === "1") {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Partial review evidence before process interruption." }, finish_reason: null }], created: 1, model: "fixture", object: "chat.completion.chunk" })}\n\n`,
              ),
            );
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("Cancelled", "AbortError")),
              { once: true },
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" }, status: 200 },
      );
    }
    return new Response(
      [
        `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: modelResponse }, finish_reason: null }], created: 1, model: "fixture", object: "chat.completion.chunk", usage: null })}`,
        "",
        'data: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"created":1,"model":"fixture","object":"chat.completion.chunk","usage":null}',
        "",
        'data: {"id":"fixture","choices":[],"created":1,"model":"fixture","object":"chat.completion.chunk","usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      { headers: { "content-type": "text/event-stream" }, status: 200 },
    );
  };
}
await import("./main.js");
