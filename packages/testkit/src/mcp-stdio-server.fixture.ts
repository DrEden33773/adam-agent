import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const spawnMarker = process.argv[2];
const closeMarker = process.argv[3];
const mode = process.argv[4] ?? "ordinary";
const callMarker = process.argv[5];
const notificationGate = process.argv[6];
if (spawnMarker === undefined || closeMarker === undefined) {
  throw new Error("The MCP stdio fixture requires spawn and close marker paths.");
}
writeFileSync(spawnMarker, String(process.pid));
if (mode === "report-module-path" && callMarker !== undefined) {
  writeFileSync(callMarker, fileURLToPath(import.meta.url));
}
if (mode === "descendant" && callMarker !== undefined) {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => undefined, 60_000)"], {
    detached: false,
    stdio: "ignore",
  });
  if (descendant.pid === undefined) {
    throw new Error("The MCP fixture could not spawn its descendant.");
  }
  writeFileSync(callMarker, String(descendant.pid));
}
if (mode === "exit-after-gate" && notificationGate !== undefined) {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => undefined, 60_000)"], {
    detached: false,
    stdio: "ignore",
  });
  if (descendant.pid === undefined) {
    throw new Error("The MCP crash fixture could not spawn its descendant.");
  }
  writeFileSync(notificationGate, String(descendant.pid));
}
const keepAlive = setInterval(() => undefined, 60_000);
let gateWatcher: ReturnType<typeof watch> | undefined;
let listChangedSent = false;
let toolListRequestCount = 0;

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  for (;;) {
    const newline = input.indexOf("\n");
    if (newline < 0) {
      break;
    }
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (line.length > 0) {
      respond(JSON.parse(line) as JsonRpcRequest);
    }
  }
});

process.on("SIGTERM", () => {
  clearInterval(keepAlive);
  gateWatcher?.close();
  appendFileSync(closeMarker, "closed\n");
  process.exit(0);
});

type JsonRpcRequest = {
  readonly id?: number | string;
  readonly method: string;
  readonly params?: {
    readonly cursor?: string;
    readonly name?: string;
    readonly arguments?: Readonly<Record<string, unknown>> & { readonly value?: unknown };
  };
};

function respond(request: JsonRpcRequest): void {
  if (mode === "request-log" && callMarker !== undefined) {
    appendFileSync(callMarker, `${request.method}\n`);
  }
  if (request.method === "initialize") {
    if (mode === "stderr-flood") {
      const secret = "never-persist-stderr-secret:";
      process.stderr.write(secret.repeat(Math.ceil((1024 * 1024) / secret.length)), () => {
        if (callMarker !== undefined) {
          writeFileSync(callMarker, "drained");
        }
        writeInitializeResult(request);
      });
      return;
    }
    if (mode === "fail-once-initialize" && callMarker !== undefined && !existsSync(callMarker)) {
      writeFileSync(callMarker, "failed-once");
      process.exit(1);
    }
    if (mode === "fail-initialize-after-gate" && callMarker !== undefined) {
      if (existsSync(callMarker)) {
        process.exit(1);
      }
      gateWatcher ??= watch(dirname(callMarker), (_event, filename) => {
        if (filename === basename(callMarker) && existsSync(callMarker)) {
          gateWatcher?.close();
          gateWatcher = undefined;
          process.exit(1);
        }
      });
      return;
    }
    if (mode === "gated-initialize" && callMarker !== undefined && !existsSync(callMarker)) {
      gateWatcher ??= watch(dirname(callMarker), (_event, filename) => {
        if (filename === basename(callMarker) && existsSync(callMarker)) {
          gateWatcher?.close();
          gateWatcher = undefined;
          writeInitializeResult(request);
        }
      });
      return;
    }
    writeInitializeResult(request);
    return;
  }
  if (request.method === "tools/list") {
    toolListRequestCount += 1;
    if (mode === "exit-after-gate" && callMarker !== undefined && gateWatcher === undefined) {
      gateWatcher = watch(dirname(callMarker), (_event, filename) => {
        if (filename === basename(callMarker) && existsSync(callMarker)) {
          gateWatcher?.close();
          gateWatcher = undefined;
          process.exit(0);
        }
      });
    }
    if (mode === "malformed-tools-list") {
      if (callMarker !== undefined) {
        writeFileSync(callMarker, "malformed");
      }
      process.stdout.write("{not-json\n");
      return;
    }
    if (mode === "oversized-frame") {
      if (callMarker !== undefined) {
        writeFileSync(callMarker, "streaming");
      }
      process.stdout.on("error", () => undefined);
      streamOversizedFrame(64 * 1024 * 1024 + 1);
      return;
    }
    if (mode === "cursor-loop") {
      writeResult(request, {
        tools: [
          {
            name: request.params?.cursor === "loop" ? "second" : "first",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        nextCursor: "loop",
      });
      return;
    }
    if (mode === "catalog-tool-overflow") {
      writeResult(request, {
        tools: Array.from({ length: 257 }, (_unused, toolIndex) => ({
          name: `tool_${toolIndex.toString().padStart(3, "0")}`,
          inputSchema: { type: "object", properties: {} },
        })),
      });
      return;
    }
    if (mode === "oversized-definition") {
      writeResult(request, {
        tools: [
          {
            name: "oversized",
            description: "x".repeat(16 * 1024),
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
      return;
    }
    if (mode === "selection-overflow") {
      writeResult(request, {
        tools: Array.from({ length: 20 }, (_unused, toolIndex) => ({
          name: `wide_${toolIndex.toString().padStart(2, "0")}`,
          description: "A selectable tool with a bounded but wide schema.",
          inputSchema: {
            type: "object",
            properties: Object.fromEntries(
              Array.from({ length: 48 }, (_property, propertyIndex) => [
                `property_${propertyIndex.toString().padStart(2, "0")}`,
                {
                  type: "string",
                  description: "A bounded property used to exercise aggregate profile limits.",
                },
              ]),
            ),
            additionalProperties: false,
          },
        })),
      });
      return;
    }
    if (mode === "selection-count-boundary") {
      writeResult(request, {
        tools: Array.from({ length: 21 }, (_unused, toolIndex) => ({
          name: `selectable_${toolIndex.toString().padStart(2, "0")}`,
          inputSchema: { type: "object", properties: {} },
        })),
      });
      return;
    }
    if (mode === "schema-reference-admission") {
      writeResult(request, {
        tools: [
          {
            name: "bounded_local_ref",
            inputSchema: {
              type: "object",
              $defs: {
                payload: {
                  type: "object",
                  properties: { value: { type: "string" } },
                  required: ["value"],
                  additionalProperties: false,
                },
              },
              properties: { payload: { $ref: "#/$defs/payload" } },
              required: ["payload"],
              additionalProperties: false,
            },
          },
          {
            name: "plain_good",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
          {
            name: "cyclic_local_ref",
            inputSchema: {
              type: "object",
              $defs: {
                node: {
                  type: "object",
                  properties: { next: { $ref: "#/$defs/node" } },
                },
              },
              properties: { node: { $ref: "#/$defs/node" } },
            },
          },
          {
            name: "remote_ref",
            inputSchema: {
              type: "object",
              properties: {
                value: { $ref: "https://example.invalid/schema.json" },
              },
            },
          },
        ],
      });
      return;
    }
    if (mode === "schema-reference-depth") {
      writeResult(request, {
        tools: [
          { name: "within_limit", inputSchema: referenceDepthSchema(16) },
          { name: "over_limit", inputSchema: referenceDepthSchema(17) },
          {
            name: "plain_good",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
        ],
      });
      return;
    }
    if (mode === "unicode-tool-order") {
      writeResult(request, {
        tools: ["äther", "zeta"].map((name) => ({
          name,
          inputSchema: { type: "object", properties: {} },
        })),
      });
      return;
    }
    if (request.params?.cursor === "page-2") {
      writeResult(request, {
        tools: [
          {
            name: "uppercase",
            description: "Uppercase a value.",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
        ],
      });
      return;
    }
    writeResult(request, {
      tools: [
        {
          name: "echo",
          description:
            mode === "list-changed-then-mutated" && toolListRequestCount > 2
              ? "Echo a changed value."
              : "Echo a value.",
          ...(mode === "annotated-readonly"
            ? { annotations: { readOnlyHint: true, destructiveHint: false } }
            : {}),
          inputSchema:
            mode === "recursive-schema"
              ? {
                  type: "object",
                  properties: { next: { $ref: "#" } },
                  additionalProperties: false,
                }
              : mode === "oneof-schema"
                ? {
                    type: "object",
                    oneOf: [
                      {
                        properties: {
                          kind: { const: "left" },
                          left: { type: "string" },
                        },
                        required: ["kind", "left"],
                      },
                      {
                        properties: {
                          kind: { const: "right" },
                          right: { type: "integer" },
                        },
                        required: ["kind", "right"],
                      },
                    ],
                  }
                : mode === "schema-from-file" && callMarker !== undefined
                  ? {
                      type: "object",
                      properties: {
                        value: { type: readFileSync(callMarker, "utf8").trim() },
                      },
                      required: ["value"],
                      additionalProperties: false,
                    }
                  : mode === "allof-schema"
                    ? {
                        type: "object",
                        $defs: {
                          left: {
                            type: "object",
                            properties: { left: { type: "string" } },
                            required: ["left"],
                          },
                          right: {
                            type: "object",
                            properties: { right: { type: "integer" } },
                            required: ["right"],
                          },
                        },
                        allOf: [{ $ref: "#/$defs/left" }, { $ref: "#/$defs/right" }],
                        additionalProperties: false,
                      }
                    : {
                        type: "object",
                        properties: { value: { type: "string" } },
                        required: ["value"],
                        additionalProperties: false,
                      },
          ...(mode === "invalid-output" || mode === "invalid-error-output"
            ? {
                outputSchema: {
                  type: "object",
                  properties: { echoed: { type: "integer" } },
                  required: ["echoed"],
                  additionalProperties: false,
                },
              }
            : {}),
        },
      ],
      nextCursor: "page-2",
    });
    return;
  }
  if (request.method === "tools/call") {
    if (callMarker !== undefined) {
      if (
        mode === "list-changed-after-call" ||
        mode === "list-changed-once" ||
        mode === "list-changed-then-mutated"
      ) {
        appendFileSync(callMarker, `${JSON.stringify(request.params)}\n`);
      } else {
        writeFileSync(callMarker, JSON.stringify(request.params));
      }
    }
    if (mode === "close-on-call") {
      process.exit(0);
    }
    if (mode === "malformed-on-call") {
      process.stdout.write("{not-json\n");
      return;
    }
    if (mode === "invalid-utf8-on-call" && request.id !== undefined) {
      process.stdout.write(
        Buffer.concat([
          Buffer.from(
            `{"jsonrpc":"2.0","id":${JSON.stringify(request.id)},"result":{"content":[{"type":"text","text":"`,
          ),
          Buffer.from([0xff]),
          Buffer.from('"}]}}\n'),
        ]),
      );
      return;
    }
    if (mode === "partial-frame-on-call") {
      process.stdout.write('{"jsonrpc":"2.0"');
      process.exit(0);
    }
    if (mode === "hold-call") {
      return;
    }
    if (mode === "jsonrpc-error-on-call") {
      if (request.id !== undefined) {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32_603, message: "fixture tool error" },
          })}\n`,
        );
      }
      return;
    }
    const value = request.params?.arguments?.value;
    if (request.params?.name !== "echo" || typeof value !== "string") {
      writeResult(request, {
        content: [{ type: "text", text: "invalid fixture call" }],
        isError: true,
      });
      return;
    }
    if (mode === "unsupported-result") {
      writeResult(request, {
        content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
      });
      return;
    }
    let structuredContent: unknown = { echoed: value };
    if (mode === "deep-structured-result") {
      for (let depth = 0; depth < 128; depth += 1) {
        structuredContent = { nested: structuredContent };
      }
    }
    writeResult(request, {
      content: [
        {
          type: "text",
          text:
            mode === "oversized-result"
              ? "x".repeat(8 * 1024 * 1024 + 1)
              : mode === "large-result"
                ? "x".repeat(70_000)
                : value,
        },
      ],
      ...(mode === "large-result" || mode === "oversized-result" ? {} : { structuredContent }),
      ...(mode === "tool-error-result" || mode === "invalid-error-output" ? { isError: true } : {}),
    });
    if (
      mode === "list-changed-after-call" ||
      ((mode === "list-changed-once" || mode === "list-changed-then-mutated") && !listChangedSent)
    ) {
      listChangedSent = true;
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n`,
      );
    }
  }
}

function writeInitializeResult(request: JsonRpcRequest): void {
  writeResult(request, {
    protocolVersion: "2025-11-25",
    capabilities: { tools: { listChanged: true } },
    serverInfo: {
      name: mode === "oversized-server-identity" ? "x".repeat(257) : "adam-mcp-fixture",
      version:
        mode === "server-version-from-file" && callMarker !== undefined
          ? readFileSync(callMarker, "utf8").trim()
          : "1.0.0",
    },
  });
  if (mode === "list-changed-on-gate" && notificationGate !== undefined) {
    const notify = () => {
      if (listChangedSent) {
        return;
      }
      listChangedSent = true;
      gateWatcher?.close();
      gateWatcher = undefined;
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n`,
      );
    };
    if (existsSync(notificationGate)) {
      notify();
    } else {
      gateWatcher ??= watch(dirname(notificationGate), (_event, filename) => {
        if (filename === basename(notificationGate) && existsSync(notificationGate)) {
          notify();
        }
      });
    }
  }
}

function referenceDepthSchema(referenceCount: number): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    $defs: Object.fromEntries(
      Array.from({ length: referenceCount }, (_unused, index) => [
        `level_${index}`,
        index === referenceCount - 1 ? { type: "string" } : { $ref: `#/$defs/level_${index + 1}` },
      ]),
    ),
    properties: { value: { $ref: "#/$defs/level_0" } },
    required: ["value"],
    additionalProperties: false,
  };
}

function streamOversizedFrame(totalBytes: number): void {
  const chunk = Buffer.alloc(1024 * 1024, 0x20);
  let remaining = totalBytes;
  const writeNext = () => {
    while (remaining > 0) {
      const next = remaining >= chunk.byteLength ? chunk : chunk.subarray(0, remaining);
      remaining -= next.byteLength;
      if (!process.stdout.write(next)) {
        process.stdout.once("drain", writeNext);
        return;
      }
    }
  };
  writeNext();
}

function writeResult(request: JsonRpcRequest, result: unknown): void {
  if (request.id === undefined) {
    return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}
