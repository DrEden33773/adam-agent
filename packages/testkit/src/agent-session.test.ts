import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentSession,
  createPermissionPolicy,
  createReadToolRegistry,
  type RuntimeEvent,
} from "@adam-agent/agent";
import { describe, expect, test } from "vitest";

import { FakeModelDriver } from "./index.js";

describe("AgentSession", () => {
  test("an answer-only turn emits ordered events and returns its terminal result", async () => {
    const model = new FakeModelDriver([
      { type: "text_delta", text: "Hello, " },
      { type: "text_delta", text: "Adam." },
      { type: "finish", reason: "stop" },
    ]);
    const session = new AgentSession({ model });
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    const result = await session.run({ text: "Introduce yourself" });

    expect(result).toEqual({ status: "completed", answer: "Hello, Adam." });
    expect(events).toEqual([
      { type: "user_message", text: "Introduce yourself" },
      { type: "model_message_started" },
      { type: "model_message_delta", text: "Hello, " },
      { type: "model_message_delta", text: "Adam." },
      { type: "model_message_completed", text: "Hello, Adam." },
      {
        type: "session_settled",
        result: { status: "completed", answer: "Hello, Adam." },
      },
    ]);
  });

  test("sends the user input to the model driver", async () => {
    const model = new FakeModelDriver((request) => {
      const firstMessage = request.messages[0];
      return [
        {
          type: "text_delta",
          text: firstMessage?.role === "user" ? firstMessage.content : "missing user input",
        },
        { type: "finish", reason: "stop" },
      ];
    });
    const session = new AgentSession({ model });

    const result = await session.run({ text: "Explain this repository" });

    expect(result).toEqual({
      status: "completed",
      answer: "Explain this repository",
    });
  });

  test("reports a failed terminal result when the model stream ends without finishing", async () => {
    const model = new FakeModelDriver([{ type: "text_delta", text: "Partial answer" }]);
    const session = new AgentSession({ model });
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    const result = await session.run({ text: "Answer completely" });

    expect(result).toEqual({
      status: "failed",
      error: {
        code: "model_stream_incomplete",
        message: "The model stream ended without a finish event.",
      },
    });
    expect(events.at(-1)).toEqual({ type: "session_settled", result });
  });

  test("answers from one read_file result without changing the repository", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-read-"));
    const readmePath = join(workspaceRoot, "README.md");
    const originalReadme = "# Orchard\n\nThis repository grows pears.\n";

    try {
      await writeFile(readmePath, originalReadme, "utf8");
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-1", name: "read_file" },
            { type: "tool_call_delta", id: "call-1", json: '{"path":"README.md"}' },
            { type: "tool_call_end", id: "call-1" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedExpectedResult =
          latestMessage?.role === "tool" &&
          latestMessage.callId === "call-1" &&
          latestMessage.name === "read_file" &&
          latestMessage.result.status === "completed" &&
          JSON.stringify(latestMessage.result.output) ===
            JSON.stringify({ path: "README.md", content: originalReadme, truncated: false });

        return [
          {
            type: "text_delta",
            text: receivedExpectedResult
              ? "The repository grows pears."
              : "The repository result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = new AgentSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });

      const result = await session.run({ text: "What does this repository grow?" });

      expect(result).toEqual({
        status: "completed",
        answer: "The repository grows pears.",
      });
      expect(await readFile(readmePath, "utf8")).toBe(originalReadme);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("feeds one typed validation failure back for malformed tool input", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-invalid-"));

    try {
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-invalid", name: "read_file" },
            { type: "tool_call_delta", id: "call-invalid", json: '{"path":42}' },
            { type: "tool_call_end", id: "call-invalid" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedValidationFailure =
          latestMessage?.role === "tool" &&
          latestMessage.callId === "call-invalid" &&
          latestMessage.name === "read_file" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "invalid_tool_input";

        return [
          {
            type: "text_delta",
            text: receivedValidationFailure
              ? "The read request was invalid."
              : "The validation result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = new AgentSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });
      const events: RuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));

      const result = await session.run({ text: "Read a file using malformed input" });

      expect({
        result,
        toolEvents: events.filter((event) => event.type.startsWith("tool_")),
      }).toEqual({
        result: {
          status: "completed",
          answer: "The read request was invalid.",
        },
        toolEvents: [
          { type: "tool_requested", callId: "call-invalid", name: "read_file" },
          {
            type: "tool_failed",
            callId: "call-invalid",
            name: "read_file",
            error: {
              code: "invalid_tool_input",
              message: "The tool input did not match its schema.",
            },
          },
        ],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("fails closed with one typed result for an unknown tool", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-unknown-"));

    try {
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-unknown", name: "erase_repository" },
            { type: "tool_call_delta", id: "call-unknown", json: "{}" },
            { type: "tool_call_end", id: "call-unknown" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedUnknownToolFailure =
          latestMessage?.role === "tool" &&
          latestMessage.callId === "call-unknown" &&
          latestMessage.name === "erase_repository" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "unknown_tool";

        return [
          {
            type: "text_delta",
            text: receivedUnknownToolFailure
              ? "That tool is unavailable."
              : "The unknown-tool result was missing.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = new AgentSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });

      const result = await session.run({ text: "Use an unavailable tool" });

      expect(result).toEqual({
        status: "completed",
        answer: "That tool is unavailable.",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("feeds one permission denial back without executing the tool", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-denied-"));

    try {
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-denied", name: "read_file" },
            {
              type: "tool_call_delta",
              id: "call-denied",
              json: '{"path":"missing-file.md"}',
            },
            { type: "tool_call_end", id: "call-denied" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedPermissionDenial =
          latestMessage?.role === "tool" &&
          latestMessage.callId === "call-denied" &&
          latestMessage.name === "read_file" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "permission_denied";

        return [
          {
            type: "text_delta",
            text: receivedPermissionDenial
              ? "Reading was denied by policy."
              : "The permission result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = new AgentSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: [] }),
      });

      const result = await session.run({ text: "Read the missing file" });

      expect(result).toEqual({
        status: "completed",
        answer: "Reading was denied by policy.",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("feeds each requested tool result once in order and publishes ordered tool events", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-multiple-"));

    try {
      await writeFile(join(workspaceRoot, "first.txt"), "alpha\n", "utf8");
      await writeFile(join(workspaceRoot, "second.txt"), "beta\n", "utf8");
      const model = new FakeModelDriver((request) => {
        const toolMessages = request.messages.filter((message) => message.role === "tool");
        if (toolMessages.length === 0) {
          return [
            { type: "tool_call_start", id: "call-first", name: "read_file" },
            {
              type: "tool_call_delta",
              id: "call-first",
              json: '{"path":"first.txt"}',
            },
            { type: "tool_call_end", id: "call-first" },
            { type: "tool_call_start", id: "call-second", name: "read_file" },
            {
              type: "tool_call_delta",
              id: "call-second",
              json: '{"path":"second.txt"}',
            },
            { type: "tool_call_end", id: "call-second" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedExactlyOnceInOrder =
          toolMessages.length === 2 &&
          toolMessages[0]?.callId === "call-first" &&
          toolMessages[0].result.status === "completed" &&
          toolMessages[1]?.callId === "call-second" &&
          toolMessages[1].result.status === "completed";
        return [
          {
            type: "text_delta",
            text: receivedExactlyOnceInOrder
              ? "The files contain alpha and beta."
              : "The tool feedback was duplicated or reordered.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = new AgentSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });
      const events: RuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));

      const result = await session.run({ text: "Read both files" });

      expect({
        result,
        toolEvents: events.filter((event) => event.type.startsWith("tool_")),
      }).toEqual({
        result: {
          status: "completed",
          answer: "The files contain alpha and beta.",
        },
        toolEvents: [
          { type: "tool_requested", callId: "call-first", name: "read_file" },
          {
            type: "tool_permission_decided",
            callId: "call-first",
            name: "read_file",
            decision: "allow",
          },
          { type: "tool_started", callId: "call-first", name: "read_file" },
          {
            type: "tool_completed",
            callId: "call-first",
            name: "read_file",
            output: { path: "first.txt", content: "alpha\n", truncated: false },
          },
          { type: "tool_requested", callId: "call-second", name: "read_file" },
          {
            type: "tool_permission_decided",
            callId: "call-second",
            name: "read_file",
            decision: "allow",
          },
          { type: "tool_started", callId: "call-second", name: "read_file" },
          {
            type: "tool_completed",
            callId: "call-second",
            name: "read_file",
            output: { path: "second.txt", content: "beta\n", truncated: false },
          },
        ],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("lists workspace entries in stable relative-path order", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-list-"));

    try {
      await mkdir(join(workspaceRoot, "src"));
      await writeFile(join(workspaceRoot, "zeta.txt"), "zeta\n", "utf8");
      await writeFile(join(workspaceRoot, "src", "alpha.ts"), "export {};\n", "utf8");
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-list", name: "list_files" },
            { type: "tool_call_delta", id: "call-list", json: '{"path":"."}' },
            { type: "tool_call_end", id: "call-list" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const expectedOutput = {
          path: ".",
          entries: [
            { path: "src", type: "directory" },
            { path: "src/alpha.ts", type: "file" },
            { path: "zeta.txt", type: "file" },
          ],
          truncated: false,
        };
        const receivedStableList =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "completed" &&
          JSON.stringify(latestMessage.result.output) === JSON.stringify(expectedOutput);
        return [
          {
            type: "text_delta",
            text: receivedStableList
              ? "The workspace contains src/alpha.ts and zeta.txt."
              : "The directory listing was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = new AgentSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });

      const result = await session.run({ text: "List the workspace files" });

      expect(result).toEqual({
        status: "completed",
        answer: "The workspace contains src/alpha.ts and zeta.txt.",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("searches workspace text with stable relative locations", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-search-"));

    try {
      await mkdir(join(workspaceRoot, "src"));
      await writeFile(join(workspaceRoot, "README.md"), "Pear trees\nApple trees\n", "utf8");
      await writeFile(
        join(workspaceRoot, "src", "fruit.ts"),
        'export const fruit = "pear";\n',
        "utf8",
      );
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-search", name: "search_text" },
            {
              type: "tool_call_delta",
              id: "call-search",
              json: '{"path":".","query":"pear"}',
            },
            { type: "tool_call_end", id: "call-search" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const expectedOutput = {
          path: ".",
          query: "pear",
          matches: [
            { path: "src/fruit.ts", line: 1, column: 23, text: 'export const fruit = "pear";' },
          ],
          truncated: false,
        };
        const receivedStableSearch =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "completed" &&
          JSON.stringify(latestMessage.result.output) === JSON.stringify(expectedOutput);
        return [
          {
            type: "text_delta",
            text: receivedStableSearch
              ? "The lowercase match is in src/fruit.ts."
              : "The search result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = new AgentSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });

      const result = await session.run({ text: "Find lowercase pear" });

      expect(result).toEqual({
        status: "completed",
        answer: "The lowercase match is in src/fruit.ts.",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("rejects lexical traversal with one typed result", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-traversal-"));

    try {
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-traversal", name: "read_file" },
            {
              type: "tool_call_delta",
              id: "call-traversal",
              json: '{"path":"../outside.txt"}',
            },
            { type: "tool_call_end", id: "call-traversal" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedConfinementFailure =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "outside_workspace";
        return [
          {
            type: "text_delta",
            text: receivedConfinementFailure
              ? "The path is outside the workspace."
              : "The confinement result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = new AgentSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });

      const result = await session.run({ text: "Read outside the workspace" });

      expect(result).toEqual({
        status: "completed",
        answer: "The path is outside the workspace.",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("rejects a symlink that resolves outside the workspace", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-symlink-root-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "adam-agent-symlink-outside-"));

    try {
      const outsidePath = join(outsideRoot, "secret.txt");
      await writeFile(outsidePath, "outside secret\n", "utf8");
      await symlink(outsidePath, join(workspaceRoot, "linked-secret.txt"));
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-symlink", name: "read_file" },
            {
              type: "tool_call_delta",
              id: "call-symlink",
              json: '{"path":"linked-secret.txt"}',
            },
            { type: "tool_call_end", id: "call-symlink" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedConfinementFailure =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "outside_workspace";
        return [
          {
            type: "text_delta",
            text: receivedConfinementFailure
              ? "The symlink target is outside the workspace."
              : "The symlink confinement result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = new AgentSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });

      const result = await session.run({ text: "Read the linked secret" });

      expect(result).toEqual({
        status: "completed",
        answer: "The symlink target is outside the workspace.",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test("fails truthfully when a tool-call turn has no completed request", async () => {
    const model = new FakeModelDriver((request) => {
      const latestMessage = request.messages.at(-1);
      if (latestMessage?.role === "user") {
        return [
          { type: "tool_call_start", id: "call-incomplete", name: "read_file" },
          {
            type: "tool_call_delta",
            id: "call-incomplete",
            json: '{"path":"README.md"}',
          },
          { type: "finish", reason: "tool_calls" },
        ];
      }
      return [
        { type: "text_delta", text: "This turn should not run." },
        { type: "finish", reason: "stop" },
      ];
    });
    const session = new AgentSession({ model });

    const result = await session.run({ text: "Read the README" });

    expect(result).toEqual({
      status: "failed",
      error: {
        code: "model_protocol_invalid",
        message: "The model finished with an incomplete tool request.",
      },
    });
  });

  test("executes a retried tool call ID once and reuses its result", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-retry-"));

    try {
      await writeFile(join(workspaceRoot, "value.txt"), "one\n", "utf8");
      let round = 0;
      const model = new FakeModelDriver((request) => {
        round += 1;
        if (round <= 2) {
          return [
            { type: "tool_call_start", id: "call-retried", name: "read_file" },
            {
              type: "tool_call_delta",
              id: "call-retried",
              json: '{"path":"value.txt"}',
            },
            { type: "tool_call_end", id: "call-retried" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const toolMessages = request.messages.filter((message) => message.role === "tool");
        const feedback = toolMessages.filter((message) => message.callId === "call-retried");
        const reusedSameResult =
          feedback.length === 2 &&
          feedback[0]?.result.status === "completed" &&
          feedback[1]?.result.status === "completed" &&
          JSON.stringify(feedback[0].result) === JSON.stringify(feedback[1].result);
        return [
          {
            type: "text_delta",
            text: reusedSameResult
              ? "The retried read was reused."
              : "The retry result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = new AgentSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });
      const events: RuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));

      const result = await session.run({ text: "Read the value, including a provider retry" });

      expect({
        result,
        startedEvents: events.filter((event) => event.type === "tool_started"),
      }).toEqual({
        result: { status: "completed", answer: "The retried read was reused." },
        startedEvents: [{ type: "tool_started", callId: "call-retried", name: "read_file" }],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("fails truthfully when stop includes a completed tool request", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-stop-with-tool-"));

    try {
      await writeFile(join(workspaceRoot, "README.md"), "must not be read\n", "utf8");
      const model = new FakeModelDriver([
        { type: "tool_call_start", id: "call-stop", name: "read_file" },
        { type: "tool_call_delta", id: "call-stop", json: '{"path":"README.md"}' },
        { type: "tool_call_end", id: "call-stop" },
        { type: "finish", reason: "stop" },
      ]);
      const session = new AgentSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });
      const events: RuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));

      const result = await session.run({ text: "Stop with an unhandled tool request" });

      expect({
        result,
        startedEvents: events.filter((event) => event.type === "tool_started"),
      }).toEqual({
        result: {
          status: "failed",
          error: {
            code: "model_protocol_invalid",
            message: "The model stopped after completing a tool request.",
          },
        },
        startedEvents: [],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("returns a bounded read_file result with explicit truncation", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-bounded-read-"));

    try {
      await writeFile(join(workspaceRoot, "large.txt"), "x".repeat(65_537), "utf8");
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-large", name: "read_file" },
            { type: "tool_call_delta", id: "call-large", json: '{"path":"large.txt"}' },
            { type: "tool_call_end", id: "call-large" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const boundedOutput =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "completed" &&
          JSON.stringify(latestMessage.result.output) ===
            JSON.stringify({ path: "large.txt", content: "x".repeat(65_536), truncated: true });
        return [
          {
            type: "text_delta",
            text: boundedOutput
              ? "The read was truncated safely."
              : "The read result was unbounded.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = new AgentSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });

      const result = await session.run({ text: "Read the large file" });

      expect(result).toEqual({
        status: "completed",
        answer: "The read was truncated safely.",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("rejects conflicting tool calls with the same ID before execution", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-conflicting-id-"));

    try {
      await writeFile(join(workspaceRoot, "first.txt"), "first\n", "utf8");
      await writeFile(join(workspaceRoot, "second.txt"), "second\n", "utf8");
      const model = new FakeModelDriver([
        { type: "tool_call_start", id: "call-conflict", name: "read_file" },
        { type: "tool_call_delta", id: "call-conflict", json: '{"path":"first.txt"}' },
        { type: "tool_call_end", id: "call-conflict" },
        { type: "tool_call_start", id: "call-conflict", name: "read_file" },
        { type: "tool_call_delta", id: "call-conflict", json: '{"path":"second.txt"}' },
        { type: "tool_call_end", id: "call-conflict" },
        { type: "finish", reason: "tool_calls" },
      ]);
      const session = new AgentSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });
      const events: RuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));

      const result = await session.run({ text: "Send conflicting calls" });

      expect({
        result,
        startedEvents: events.filter((event) => event.type === "tool_started"),
      }).toEqual({
        result: {
          status: "failed",
          error: {
            code: "model_protocol_invalid",
            message: "The model reused a tool call ID with different input.",
          },
        },
        startedEvents: [],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("rejects a duplicate tool call ID within one model turn", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-duplicate-id-"));

    try {
      await writeFile(join(workspaceRoot, "value.txt"), "one\n", "utf8");
      let round = 0;
      const model = new FakeModelDriver(() => {
        round += 1;
        if (round === 1) {
          return [
            { type: "tool_call_start", id: "call-duplicate", name: "read_file" },
            {
              type: "tool_call_delta",
              id: "call-duplicate",
              json: '{"path":"value.txt"}',
            },
            { type: "tool_call_end", id: "call-duplicate" },
            { type: "tool_call_start", id: "call-duplicate", name: "read_file" },
            {
              type: "tool_call_delta",
              id: "call-duplicate",
              json: '{"path":"value.txt"}',
            },
            { type: "tool_call_end", id: "call-duplicate" },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return [
          { type: "text_delta", text: "This turn should not run." },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = new AgentSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });
      const events: RuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));

      const result = await session.run({ text: "Send one duplicate ID" });

      expect({
        result,
        startedEvents: events.filter((event) => event.type === "tool_started"),
      }).toEqual({
        result: {
          status: "failed",
          error: {
            code: "model_protocol_invalid",
            message: "The model repeated a tool call ID within one turn.",
          },
        },
        startedEvents: [],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("rejects the whole tool turn when one request is incomplete", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-partial-turn-"));

    try {
      await writeFile(join(workspaceRoot, "first.txt"), "must not be read\n", "utf8");
      const model = new FakeModelDriver([
        { type: "tool_call_start", id: "call-complete", name: "read_file" },
        { type: "tool_call_delta", id: "call-complete", json: '{"path":"first.txt"}' },
        { type: "tool_call_end", id: "call-complete" },
        { type: "tool_call_start", id: "call-incomplete", name: "read_file" },
        {
          type: "tool_call_delta",
          id: "call-incomplete",
          json: '{"path":"second.txt"}',
        },
        { type: "finish", reason: "tool_calls" },
      ]);
      const session = new AgentSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });
      const events: RuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));

      const result = await session.run({ text: "Send one complete and one incomplete call" });

      expect({
        result,
        toolEvents: events.filter((event) => event.type.startsWith("tool_")),
      }).toEqual({
        result: {
          status: "failed",
          error: {
            code: "model_protocol_invalid",
            message: "The model finished with an incomplete tool request.",
          },
        },
        toolEvents: [],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("stops listing when the result budget is exhausted", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-list-budget-"));
    const blockedDirectory = join(workspaceRoot, "zzz-blocked");

    try {
      await Promise.all(
        Array.from({ length: 200 }, (_, index) =>
          writeFile(
            join(workspaceRoot, `file-${String(index).padStart(3, "0")}.txt`),
            "x\n",
            "utf8",
          ),
        ),
      );
      await mkdir(blockedDirectory, { mode: 0o000 });
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-budget", name: "list_files" },
            { type: "tool_call_delta", id: "call-budget", json: '{"path":"."}' },
            { type: "tool_call_end", id: "call-budget" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const serializedResult =
          latestMessage?.role === "tool" && latestMessage.result.status === "completed"
            ? JSON.stringify(latestMessage.result.output)
            : "";
        const stoppedAtBudget =
          serializedResult.includes('"truncated":true') &&
          serializedResult.includes('"path":"file-199.txt"') &&
          !serializedResult.includes("zzz-blocked");
        return [
          {
            type: "text_delta",
            text: stoppedAtBudget
              ? "The listing stopped at its result budget."
              : "The listing exceeded its result budget.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = new AgentSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });

      const result = await session.run({ text: "List a bounded number of files" });

      expect(result).toEqual({
        status: "completed",
        answer: "The listing stopped at its result budget.",
      });
    } finally {
      await chmod(blockedDirectory, 0o700).catch(() => undefined);
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("rejects a duplicate tool-call start before execution", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-duplicate-start-"));

    try {
      await writeFile(join(workspaceRoot, "value.txt"), "must not be read\n", "utf8");
      const model = new FakeModelDriver([
        { type: "tool_call_start", id: "call-start", name: "read_file" },
        { type: "tool_call_delta", id: "call-start", json: '{"path":"value.txt"}' },
        { type: "tool_call_start", id: "call-start", name: "read_file" },
        { type: "tool_call_delta", id: "call-start", json: '{"path":"value.txt"}' },
        { type: "tool_call_end", id: "call-start" },
        { type: "finish", reason: "tool_calls" },
      ]);
      const session = new AgentSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });
      const events: RuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));

      const result = await session.run({ text: "Send a duplicate tool-call start" });

      expect({
        result,
        toolEvents: events.filter((event) => event.type.startsWith("tool_")),
      }).toEqual({
        result: {
          status: "failed",
          error: {
            code: "model_protocol_invalid",
            message: "The model started the same tool call more than once.",
          },
        },
        toolEvents: [],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test.each([
    {
      label: "arguments",
      event: { type: "tool_call_delta", id: "orphan", json: "{}" } as const,
      message: "The model sent arguments for a tool call that was not started.",
    },
    {
      label: "end",
      event: { type: "tool_call_end", id: "orphan" } as const,
      message: "The model ended a tool call that was not started.",
    },
  ])("rejects an orphaned tool-call $label event", async ({ event, message }) => {
    const model = new FakeModelDriver([event, { type: "finish", reason: "tool_calls" }]);
    const session = new AgentSession({ model });
    const events: RuntimeEvent[] = [];
    session.subscribe((runtimeEvent) => events.push(runtimeEvent));

    const result = await session.run({ text: "Send a malformed tool-call stream" });

    expect({
      result,
      toolEvents: events.filter((runtimeEvent) => runtimeEvent.type.startsWith("tool_")),
    }).toEqual({
      result: {
        status: "failed",
        error: { code: "model_protocol_invalid", message },
      },
      toolEvents: [],
    });
  });

  test("does not mark a complete listing as truncated when its final entry is empty", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-exact-list-budget-"));

    try {
      await Promise.all(
        Array.from({ length: 199 }, (_, index) =>
          writeFile(
            join(workspaceRoot, `file-${String(index).padStart(3, "0")}.txt`),
            "x\n",
            "utf8",
          ),
        ),
      );
      await mkdir(join(workspaceRoot, "zzz-empty"));
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-exact-budget", name: "list_files" },
            { type: "tool_call_delta", id: "call-exact-budget", json: '{"path":"."}' },
            { type: "tool_call_end", id: "call-exact-budget" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const serializedResult =
          latestMessage?.role === "tool" && latestMessage.result.status === "completed"
            ? JSON.stringify(latestMessage.result.output)
            : "";
        const listingIsComplete =
          serializedResult.includes('"path":"zzz-empty","type":"directory"') &&
          serializedResult.includes('"truncated":false');
        return [
          {
            type: "text_delta",
            text: listingIsComplete
              ? "The exact-budget listing is complete."
              : "The exact-budget listing was reported incorrectly.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = new AgentSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });

      const result = await session.run({ text: "List exactly the result budget" });

      expect(result).toEqual({
        status: "completed",
        answer: "The exact-budget listing is complete.",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("bounds search match text from a long source line", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-search-line-budget-"));

    try {
      await writeFile(join(workspaceRoot, "long.txt"), `needle${"x".repeat(2_000)}\n`, "utf8");
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-search-line", name: "search_text" },
            {
              type: "tool_call_delta",
              id: "call-search-line",
              json: '{"path":".","query":"needle"}',
            },
            { type: "tool_call_end", id: "call-search-line" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const output =
          latestMessage?.role === "tool" && latestMessage.result.status === "completed"
            ? latestMessage.result.output
            : undefined;
        const serializedOutput = JSON.stringify(output);
        const bounded =
          serializedOutput.includes('"truncated":true') &&
          !serializedOutput.includes("x".repeat(1_025));
        return [
          {
            type: "text_delta",
            text: bounded ? "The match text was bounded." : "The match text was unbounded.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = new AgentSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });

      const result = await session.run({ text: "Search a long line safely" });

      expect(result).toEqual({ status: "completed", answer: "The match text was bounded." });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("rejects an oversized search query before execution", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-search-query-budget-"));
    const query = "x".repeat(1_025);

    try {
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-search-query", name: "search_text" },
            {
              type: "tool_call_delta",
              id: "call-search-query",
              json: JSON.stringify({ path: ".", query }),
            },
            { type: "tool_call_end", id: "call-search-query" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const rejected =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "invalid_tool_input";
        return [
          {
            type: "text_delta",
            text: rejected ? "The oversized query was rejected." : "The query was accepted.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = new AgentSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });
      const events: RuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));

      const result = await session.run({ text: "Search with an oversized query" });

      expect({
        result,
        startedEvents: events.filter((event) => event.type === "tool_started"),
      }).toEqual({
        result: { status: "completed", answer: "The oversized query was rejected." },
        startedEvents: [],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("returns matches from the bounded prefix of a truncated file", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-truncated-search-"));

    try {
      await writeFile(join(workspaceRoot, "large.txt"), `needle\n${"x".repeat(70_000)}`, "utf8");
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-truncated-search", name: "search_text" },
            {
              type: "tool_call_delta",
              id: "call-truncated-search",
              json: '{"path":".","query":"needle"}',
            },
            { type: "tool_call_end", id: "call-truncated-search" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const serializedResult =
          latestMessage?.role === "tool" && latestMessage.result.status === "completed"
            ? JSON.stringify(latestMessage.result.output)
            : "";
        const keptPrefixMatch =
          serializedResult.includes('"line":1') && serializedResult.includes('"truncated":true');
        return [
          {
            type: "text_delta",
            text: keptPrefixMatch
              ? "The bounded prefix match was returned."
              : "The bounded prefix match was lost.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = new AgentSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });

      const result = await session.run({ text: "Search the bounded file prefix" });

      expect(result).toEqual({
        status: "completed",
        answer: "The bounded prefix match was returned.",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
