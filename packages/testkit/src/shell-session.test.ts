import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentSession,
  createCodingToolRegistry,
  createFileArtifactStore,
  createInMemorySessionStore,
  createPermissionPolicy,
  type ModelDriver,
  type RuntimeEvent,
} from "@adam-agent/agent";
import { expect, test } from "vitest";

import { FakeModelDriver } from "./index.js";

test("the default coding registry exposes exactly the four approved tools", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-coding-registry-"));

  try {
    const registry = createCodingToolRegistry({ workspaceRoot });

    expect({
      definitions: registry.definitions().map((definition) => definition.name),
      listFiles: registry.resolve("list_files"),
      searchText: registry.resolve("search_text"),
    }).toEqual({
      definitions: ["read_file", "write_file", "edit_file", "run_shell"],
      listFiles: undefined,
      searchText: undefined,
    });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("an approved shell command runs from the workspace root and persists its result", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-shell-success-"));
  const store = createInMemorySessionStore();
  const command = "printf 'shell output\\n'; pwd";
  const expectedStdout = `shell output\n${workspaceRoot}\n`;

  try {
    const model: ModelDriver = new FakeModelDriver((request) => {
      const latestMessage = request.messages.at(-1);
      if (latestMessage?.role === "user") {
        return [
          { type: "tool_call_start", id: "call-shell-success", name: "run_shell" },
          {
            type: "tool_call_delta",
            id: "call-shell-success",
            json: JSON.stringify({ command }),
          },
          { type: "tool_call_end", id: "call-shell-success" },
          { type: "finish", reason: "tool_calls" },
        ];
      }

      const receivedExpectedResult =
        latestMessage?.role === "tool" &&
        latestMessage.result.status === "completed" &&
        JSON.stringify(latestMessage.result.output) ===
          JSON.stringify({
            termination: { type: "exited", exitCode: 0 },
            stdout: {
              tail: expectedStdout,
              totalBytes: Buffer.byteLength(expectedStdout),
              omittedBytes: 0,
            },
            stderr: { tail: "", totalBytes: 0, omittedBytes: 0 },
          });
      return [
        {
          type: "text_delta",
          text: receivedExpectedResult
            ? "The approved shell command completed."
            : "The shell result was unexpected.",
        },
        { type: "finish", reason: "stop" },
      ];
    });
    const session = new AgentSession({
      model,
      tools: createCodingToolRegistry({ workspaceRoot }),
      permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["execute"] }),
      store,
    });
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
      if (event.type === "tool_permission_requested") {
        session.decidePermission({ requestId: event.requestId, decision: "allow" });
      }
    });

    const result = await session.run({ text: "Run the verification command" });
    const persistedToolEvents = (await store.read())
      .map((record) => record.event)
      .filter((event) => event.type.startsWith("tool_"));

    expect({ result, persistedToolEvents }).toEqual({
      result: { status: "completed", answer: "The approved shell command completed." },
      persistedToolEvents: [
        { type: "tool_requested", callId: "call-shell-success", name: "run_shell" },
        {
          type: "tool_permission_requested",
          requestId: expect.any(String),
          callId: "call-shell-success",
          name: "run_shell",
          effect: "execute",
          scope: "call",
          subject: { type: "command", command, cwd: "." },
        },
        {
          type: "tool_permission_decided",
          requestId: expect.any(String),
          callId: "call-shell-success",
          name: "run_shell",
          decision: "allow",
          effect: "execute",
          scope: "call",
          subject: { type: "command", command, cwd: "." },
        },
        { type: "tool_started", callId: "call-shell-success", name: "run_shell" },
        {
          type: "tool_completed",
          callId: "call-shell-success",
          name: "run_shell",
          output: {
            termination: { type: "exited", exitCode: 0 },
            stdout: {
              tail: expectedStdout,
              totalBytes: Buffer.byteLength(expectedStdout),
              omittedBytes: 0,
            },
            stderr: { tail: "", totalBytes: 0, omittedBytes: 0 },
          },
        },
      ],
    });
    expect(events.some((event) => event.type === "session_settled")).toBe(true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("a non-zero shell exit is a completed result that the model can handle", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-shell-nonzero-"));
  const store = createInMemorySessionStore();

  try {
    const model = new FakeModelDriver((request) => {
      const latestMessage = request.messages.at(-1);
      if (latestMessage?.role === "user") {
        return [
          { type: "tool_call_start", id: "call-shell-nonzero", name: "run_shell" },
          {
            type: "tool_call_delta",
            id: "call-shell-nonzero",
            json: '{"command":"printf output; printf failure >&2; exit 7"}',
          },
          { type: "tool_call_end", id: "call-shell-nonzero" },
          { type: "finish", reason: "tool_calls" },
        ];
      }

      const output =
        latestMessage?.role === "tool" && latestMessage.result.status === "completed"
          ? JSON.stringify(latestMessage.result.output)
          : "";
      return [
        {
          type: "text_delta",
          text: output.includes('"exitCode":7')
            ? "The command reported exit code 7."
            : "The non-zero exit was misclassified.",
        },
        { type: "finish", reason: "stop" },
      ];
    });
    const session = new AgentSession({
      model,
      tools: createCodingToolRegistry({ workspaceRoot }),
      permissions: createPermissionPolicy({ allowedEffects: ["execute"] }),
      store,
    });

    const result = await session.run({ text: "Run a failing verification command" });
    const completed = (await store.read())
      .map((record) => record.event)
      .find((event) => event.type === "tool_completed" && event.callId === "call-shell-nonzero");

    expect({
      result,
      output: completed?.type === "tool_completed" ? completed.output : null,
    }).toEqual({
      result: { status: "completed", answer: "The command reported exit code 7." },
      output: {
        termination: { type: "exited", exitCode: 7 },
        stdout: { tail: "output", totalBytes: 6, omittedBytes: 0 },
        stderr: { tail: "failure", totalBytes: 7, omittedBytes: 0 },
      },
    });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("the shell receives an isolated HOME and does not inherit unrelated runtime variables", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-shell-environment-"));
  const store = createInMemorySessionStore();
  const environmentName = "ADAM_AGENT_TEST_SECRET";
  const previousValue = process.env[environmentName];
  process.env[environmentName] = "must-not-leak";

  try {
    const command = `printf '%s\\n%s\\n%s\\n' "\${${environmentName}-unset}" "$HOME" "$PWD"`;
    const model = new FakeModelDriver((request) => {
      if (request.messages.at(-1)?.role === "user") {
        return [
          { type: "tool_call_start", id: "call-shell-environment", name: "run_shell" },
          {
            type: "tool_call_delta",
            id: "call-shell-environment",
            json: JSON.stringify({ command }),
          },
          { type: "tool_call_end", id: "call-shell-environment" },
          { type: "finish", reason: "tool_calls" },
        ];
      }
      return [
        { type: "text_delta", text: "The shell environment was inspected." },
        { type: "finish", reason: "stop" },
      ];
    });
    const session = new AgentSession({
      model,
      tools: createCodingToolRegistry({ workspaceRoot }),
      permissions: createPermissionPolicy({ allowedEffects: ["execute"] }),
      store,
    });

    await session.run({ text: "Inspect the shell environment" });
    const completed = (await store.read())
      .map((record) => record.event)
      .find(
        (event) => event.type === "tool_completed" && event.callId === "call-shell-environment",
      );
    const output = requireJsonObject(
      completed?.type === "tool_completed" ? completed.output : null,
    );
    const stdout = requireJsonObject(jsonProperty(output, "stdout"));
    const lines = String(jsonProperty(stdout, "tail")).trimEnd().split("\n");

    expect(lines).toEqual([
      "unset",
      expect.stringMatching(/^\/tmp\/adam-agent-shell-home-/u),
      workspaceRoot,
    ]);
  } finally {
    if (previousValue === undefined) {
      delete process.env[environmentName];
    } else {
      process.env[environmentName] = previousValue;
    }
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("a shell process that cannot start returns a typed failure", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-shell-start-failure-"));
  await rm(workspaceRoot, { recursive: true, force: true });
  const model = new FakeModelDriver((request) => {
    const latestMessage = request.messages.at(-1);
    if (latestMessage?.role === "user") {
      return [
        { type: "tool_call_start", id: "call-shell-start-failure", name: "run_shell" },
        {
          type: "tool_call_delta",
          id: "call-shell-start-failure",
          json: '{"command":"exit 0"}',
        },
        { type: "tool_call_end", id: "call-shell-start-failure" },
        { type: "finish", reason: "tool_calls" },
      ];
    }

    const receivedStartFailure =
      latestMessage?.role === "tool" &&
      latestMessage.result.status === "failed" &&
      latestMessage.result.error.code === "shell_start_failed";
    return [
      {
        type: "text_delta",
        text: receivedStartFailure
          ? "The shell process could not start."
          : "The shell start failure was misclassified.",
      },
      { type: "finish", reason: "stop" },
    ];
  });
  const session = new AgentSession({
    model,
    tools: createCodingToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["execute"] }),
    store: createInMemorySessionStore(),
  });
  const events: RuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));

  const result = await session.run({ text: "Run a command from the missing workspace" });

  expect({
    result,
    finalToolEvent: events.filter((event) => event.type.startsWith("tool_")).at(-1),
  }).toEqual({
    result: { status: "completed", answer: "The shell process could not start." },
    finalToolEvent: {
      type: "tool_failed",
      callId: "call-shell-start-failure",
      name: "run_shell",
      error: {
        code: "shell_start_failed",
        message: "The shell process could not be started.",
      },
    },
  });
});

test("a timed-out shell command cannot outlive the process-group termination grace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-shell-timeout-"));
  const command =
    "printf 'before timeout\\n'; trap '' TERM; sleep 0.4; printf survived > survived.txt";

  try {
    const model = new FakeModelDriver((request) => {
      const latestMessage = request.messages.at(-1);
      if (latestMessage?.role === "user") {
        return [
          { type: "tool_call_start", id: "call-shell-timeout", name: "run_shell" },
          {
            type: "tool_call_delta",
            id: "call-shell-timeout",
            json: JSON.stringify({ command, timeoutMs: 20 }),
          },
          { type: "tool_call_end", id: "call-shell-timeout" },
          { type: "finish", reason: "tool_calls" },
        ];
      }

      const receivedTimeout =
        latestMessage?.role === "tool" &&
        latestMessage.result.status === "completed" &&
        JSON.stringify(latestMessage.result.output).includes('"type":"timed_out"');
      return [
        {
          type: "text_delta",
          text: receivedTimeout ? "The command timed out." : "The timeout was misclassified.",
        },
        { type: "finish", reason: "stop" },
      ];
    });
    const session = new AgentSession({
      model,
      tools: createCodingToolRegistry({ workspaceRoot }),
      permissions: createPermissionPolicy({ allowedEffects: ["execute"] }),
      store: createInMemorySessionStore(),
    });

    const result = await session.run({ text: "Run a command with a short timeout" });

    expect({
      result,
      survived: await readFile(join(workspaceRoot, "survived.txt"), "utf8").catch(() => undefined),
    }).toEqual({
      result: { status: "completed", answer: "The command timed out." },
      survived: undefined,
    });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("timeout cleanup kills a detached descendant after the shell leader exits", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-shell-descendant-timeout-"));
  const command =
    '(trap "" TERM; sleep 0.5; printf survived > survived.txt) </dev/null >/dev/null 2>/dev/null & wait';

  try {
    const model = new FakeModelDriver((request) => {
      if (request.messages.at(-1)?.role === "user") {
        return [
          { type: "tool_call_start", id: "call-shell-descendant-timeout", name: "run_shell" },
          {
            type: "tool_call_delta",
            id: "call-shell-descendant-timeout",
            json: JSON.stringify({ command, timeoutMs: 20 }),
          },
          { type: "tool_call_end", id: "call-shell-descendant-timeout" },
          { type: "finish", reason: "tool_calls" },
        ];
      }
      return [
        { type: "text_delta", text: "The descendant process was cleaned up." },
        { type: "finish", reason: "stop" },
      ];
    });
    const session = new AgentSession({
      model,
      tools: createCodingToolRegistry({ workspaceRoot }),
      permissions: createPermissionPolicy({ allowedEffects: ["execute"] }),
      store: createInMemorySessionStore(),
    });

    const result = await session.run({ text: "Time out a shell with a detached descendant" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 650));

    expect({
      result,
      survived: await readFile(join(workspaceRoot, "survived.txt"), "utf8").catch(() => undefined),
    }).toEqual({
      result: { status: "completed", answer: "The descendant process was cleaned up." },
      survived: undefined,
    });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("the first timeout remains the shell outcome when caller cancellation races afterward", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-shell-timeout-race-"));
  const store = createInMemorySessionStore();
  const command = "trap 'printf timeout > timeout.txt' TERM; while :; do sleep 1; done";

  try {
    const model = new FakeModelDriver((request) => {
      if (request.messages.at(-1)?.role === "user") {
        return [
          { type: "tool_call_start", id: "call-shell-timeout-race", name: "run_shell" },
          {
            type: "tool_call_delta",
            id: "call-shell-timeout-race",
            json: JSON.stringify({ command, timeoutMs: 20 }),
          },
          { type: "tool_call_end", id: "call-shell-timeout-race" },
          { type: "finish", reason: "tool_calls" },
        ];
      }
      return [
        { type: "text_delta", text: "Cancellation must not overwrite the timeout." },
        { type: "finish", reason: "stop" },
      ];
    });
    const session = new AgentSession({
      model,
      tools: createCodingToolRegistry({ workspaceRoot }),
      permissions: createPermissionPolicy({ allowedEffects: ["execute"] }),
      store,
    });

    const run = session.run({ text: "Time out and then cancel the command" });
    await waitForFile(join(workspaceRoot, "timeout.txt"));
    session.abort();
    const result = await run;
    const completed = (await store.read())
      .map((record) => record.event)
      .find(
        (event) => event.type === "tool_completed" && event.callId === "call-shell-timeout-race",
      );
    const output = requireJsonObject(
      completed?.type === "tool_completed" ? completed.output : null,
    );

    expect({ result, termination: jsonProperty(output, "termination") }).toEqual({
      result: {
        status: "cancelled",
        error: { code: "session_cancelled", message: "The session was cancelled." },
      },
      termination: { type: "timed_out" },
    });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("aborting an active shell command records interruption and removes its process group", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-shell-abort-"));
  const store = createInMemorySessionStore();
  const command =
    "trap '' TERM; printf started > started.txt; sleep 0.4; printf survived > survived.txt";

  try {
    const model = new FakeModelDriver((request) => {
      if (request.messages.at(-1)?.role === "user") {
        return [
          { type: "tool_call_start", id: "call-shell-abort", name: "run_shell" },
          {
            type: "tool_call_delta",
            id: "call-shell-abort",
            json: JSON.stringify({ command }),
          },
          { type: "tool_call_end", id: "call-shell-abort" },
          { type: "finish", reason: "tool_calls" },
        ];
      }
      return [
        { type: "text_delta", text: "The interrupted command must not resume the model." },
        { type: "finish", reason: "stop" },
      ];
    });
    const session = new AgentSession({
      model,
      tools: createCodingToolRegistry({ workspaceRoot }),
      permissions: createPermissionPolicy({ allowedEffects: ["execute"] }),
      store,
    });

    const run = session.run({ text: "Start and then cancel the command" });
    await waitForFile(join(workspaceRoot, "started.txt"));
    session.abort();
    const result = await run;
    const persisted = (await store.read()).map((record) => record.event);
    const completed = persisted.find(
      (event) => event.type === "tool_completed" && event.callId === "call-shell-abort",
    );
    const completedOutput = requireJsonObject(
      completed?.type === "tool_completed" ? completed.output : null,
    );

    expect({
      result,
      termination: jsonProperty(completedOutput, "termination"),
      survived: await readFile(join(workspaceRoot, "survived.txt"), "utf8").catch(() => undefined),
      terminalEvents: persisted.filter(
        (event) => event.type === "session_interrupted" || event.type === "session_settled",
      ),
    }).toEqual({
      result: {
        status: "cancelled",
        error: { code: "session_cancelled", message: "The session was cancelled." },
      },
      termination: { type: "interrupted" },
      survived: undefined,
      terminalEvents: [
        { type: "session_interrupted", reason: "cancelled" },
        {
          type: "session_settled",
          result: {
            status: "cancelled",
            error: { code: "session_cancelled", message: "The session was cancelled." },
          },
        },
      ],
    });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("overflowing shell output is durably referenced before its bounded result is persisted", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-shell-artifact-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const artifactStore = await createFileArtifactStore({ root: join(testRoot, "artifacts") });
  const store = createInMemorySessionStore();
  const expectedBytes = Buffer.from("x\n".repeat(35_000), "utf8");
  const expectedTail = expectedBytes
    .subarray(expectedBytes.byteLength - 64 * 1024)
    .toString("utf8");

  try {
    const model = new FakeModelDriver((request) => {
      const latestMessage = request.messages.at(-1);
      if (latestMessage?.role === "user") {
        return [
          { type: "tool_call_start", id: "call-shell-artifact", name: "run_shell" },
          {
            type: "tool_call_delta",
            id: "call-shell-artifact",
            json: '{"command":"yes x | head -c 70000"}',
          },
          { type: "tool_call_end", id: "call-shell-artifact" },
          { type: "finish", reason: "tool_calls" },
        ];
      }

      const serializedResult =
        latestMessage?.role === "tool" && latestMessage.result.status === "completed"
          ? JSON.stringify(latestMessage.result.output)
          : "";
      const receivedArtifactReference =
        serializedResult.includes('"byteCount":70000') &&
        serializedResult.includes('"stream":"stdout"');
      return [
        {
          type: "text_delta",
          text: receivedArtifactReference
            ? "The complete output is available as an artifact."
            : "The overflowing output was not preserved.",
        },
        { type: "finish", reason: "stop" },
      ];
    });
    const session = new AgentSession({
      model,
      tools: createCodingToolRegistry({ workspaceRoot, artifactStore }),
      permissions: createPermissionPolicy({ allowedEffects: ["execute"] }),
      store,
    });

    const result = await session.run({ text: "Capture the long command output" });
    const persistedCompleted = (await store.read())
      .map((record) => record.event)
      .find((event) => event.type === "tool_completed" && event.callId === "call-shell-artifact");
    const output = requireJsonObject(
      persistedCompleted?.type === "tool_completed" ? persistedCompleted.output : undefined,
    );
    const stdout = requireJsonObject(jsonProperty(output, "stdout"));
    const artifact = requireJsonObject(jsonProperty(stdout, "artifact"));
    const artifactId = jsonProperty(artifact, "id");
    if (typeof artifactId !== "string") {
      throw new Error("The shell output did not contain an artifact ID.");
    }

    expect({
      result,
      termination: jsonProperty(output, "termination"),
      stdout,
      artifactBytes: await artifactStore.read(artifactId),
    }).toEqual({
      result: {
        status: "completed",
        answer: "The complete output is available as an artifact.",
      },
      termination: { type: "exited", exitCode: 0 },
      stdout: {
        tail: expectedTail,
        totalBytes: 70_000,
        omittedBytes: 70_000 - 64 * 1024,
        artifact: {
          id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
          mediaType: "application/octet-stream",
          byteCount: 70_000,
          source: {
            type: "tool_output",
            callId: "call-shell-artifact",
            toolName: "run_shell",
            stream: "stdout",
            totalBytes: 70_000,
            truncated: false,
          },
        },
      },
      artifactBytes: expectedBytes,
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a file artifact is published without owner write permission", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "adam-agent-artifact-mode-"));
  const artifactStore = await createFileArtifactStore({ root: artifactRoot });

  try {
    const artifact = await artifactStore.write({
      bytes: Buffer.from("immutable bytes", "utf8"),
      mediaType: "application/octet-stream",
      source: {
        type: "tool_output",
        callId: "call-artifact-mode",
        toolName: "run_shell",
        stream: "stdout",
        totalBytes: 15,
        truncated: false,
      },
    });
    const artifactPath = join(artifactRoot, artifact.id.slice("sha256:".length));

    expect((await stat(artifactPath)).mode & 0o777).toBe(0o400);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("a file artifact read rejects bytes that no longer match its content address", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "adam-agent-artifact-integrity-"));
  const artifactStore = await createFileArtifactStore({ root: artifactRoot });

  try {
    const artifact = await artifactStore.write({
      bytes: Buffer.from("original bytes", "utf8"),
      mediaType: "application/octet-stream",
      source: {
        type: "tool_output",
        callId: "call-artifact-integrity",
        toolName: "run_shell",
        stream: "stderr",
        totalBytes: 14,
        truncated: false,
      },
    });
    const artifactPath = join(artifactRoot, artifact.id.slice("sha256:".length));
    await chmod(artifactPath, 0o600);
    await writeFile(artifactPath, "tampered bytes", "utf8");

    await expect(artifactStore.read(artifact.id)).rejects.toThrow(
      "The content-addressed artifact does not match its ID.",
    );
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("runtime-owned shell limits cap both the inline tail and durable artifact", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-shell-artifact-cap-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const artifactStore = await createFileArtifactStore({ root: join(testRoot, "artifacts") });
  const store = createInMemorySessionStore();

  try {
    const model = new FakeModelDriver((request) => {
      const latestMessage = request.messages.at(-1);
      if (latestMessage?.role === "user") {
        return [
          { type: "tool_call_start", id: "call-shell-artifact-cap", name: "run_shell" },
          {
            type: "tool_call_delta",
            id: "call-shell-artifact-cap",
            json: '{"command":"printf 012345678901234567890123456789"}',
          },
          { type: "tool_call_end", id: "call-shell-artifact-cap" },
          { type: "finish", reason: "tool_calls" },
        ];
      }
      return [
        { type: "text_delta", text: "The bounded output was recorded." },
        { type: "finish", reason: "stop" },
      ];
    });
    const session = new AgentSession({
      model,
      tools: createCodingToolRegistry({
        workspaceRoot,
        artifactStore,
        shellLimits: {
          timeoutMs: 1_000,
          terminationGraceMs: 50,
          maximumInlineBytesPerStream: 8,
          maximumArtifactBytesPerStream: 16,
        },
      }),
      permissions: createPermissionPolicy({ allowedEffects: ["execute"] }),
      store,
    });

    const result = await session.run({ text: "Capture output under runtime limits" });
    const completed = (await store.read())
      .map((record) => record.event)
      .find(
        (event) => event.type === "tool_completed" && event.callId === "call-shell-artifact-cap",
      );
    const output = requireJsonObject(
      completed?.type === "tool_completed" ? completed.output : null,
    );
    const stdout = requireJsonObject(jsonProperty(output, "stdout"));
    const artifact = requireJsonObject(jsonProperty(stdout, "artifact"));
    const artifactSource = requireJsonObject(jsonProperty(artifact, "source"));
    const artifactId = jsonProperty(artifact, "id");
    if (typeof artifactId !== "string") {
      throw new Error("The capped shell output did not contain an artifact ID.");
    }

    expect({
      result,
      stdout,
      truncated: jsonProperty(artifactSource, "truncated"),
      artifactBytes: await artifactStore.read(artifactId),
    }).toEqual({
      result: { status: "completed", answer: "The bounded output was recorded." },
      stdout: {
        tail: "23456789",
        totalBytes: 30,
        omittedBytes: 22,
        artifact: {
          id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
          mediaType: "application/octet-stream",
          byteCount: 16,
          source: {
            type: "tool_output",
            callId: "call-shell-artifact-cap",
            toolName: "run_shell",
            stream: "stdout",
            totalBytes: 30,
            truncated: true,
          },
        },
      },
      truncated: true,
      artifactBytes: Buffer.from("0123456789012345", "utf8"),
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("an artifact write failure cannot publish a dangling completed shell result", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-shell-artifact-failure-"));
  const workspaceRoot = join(testRoot, "workspace");
  const artifactRoot = join(testRoot, "artifacts");
  await mkdir(workspaceRoot);
  const artifactStore = await createFileArtifactStore({ root: artifactRoot });
  await chmod(artifactRoot, 0o500);
  const store = createInMemorySessionStore();

  try {
    const model = new FakeModelDriver((request) => {
      const latestMessage = request.messages.at(-1);
      if (latestMessage?.role === "user") {
        return [
          { type: "tool_call_start", id: "call-shell-artifact-failure", name: "run_shell" },
          {
            type: "tool_call_delta",
            id: "call-shell-artifact-failure",
            json: '{"command":"yes x | head -c 70000"}',
          },
          { type: "tool_call_end", id: "call-shell-artifact-failure" },
          { type: "finish", reason: "tool_calls" },
        ];
      }
      const receivedStorageFailure =
        latestMessage?.role === "tool" &&
        latestMessage.result.status === "failed" &&
        latestMessage.result.error.code === "artifact_store_failed";
      return [
        {
          type: "text_delta",
          text: receivedStorageFailure
            ? "The artifact failure was reported."
            : "A dangling artifact result was accepted.",
        },
        { type: "finish", reason: "stop" },
      ];
    });
    const session = new AgentSession({
      model,
      tools: createCodingToolRegistry({ workspaceRoot, artifactStore }),
      permissions: createPermissionPolicy({ allowedEffects: ["execute"] }),
      store,
    });

    const result = await session.run({ text: "Capture output in an unavailable store" });
    const toolTerminalEvents = (await store.read())
      .map((record) => record.event)
      .filter((event) => event.type === "tool_completed" || event.type === "tool_failed");

    expect({ result, toolTerminalEvents }).toEqual({
      result: { status: "completed", answer: "The artifact failure was reported." },
      toolTerminalEvents: [
        {
          type: "tool_failed",
          callId: "call-shell-artifact-failure",
          name: "run_shell",
          error: {
            code: "artifact_store_failed",
            message: "The overflowing shell output could not be stored.",
          },
        },
      ],
    });
  } finally {
    await chmod(artifactRoot, 0o700).catch(() => {});
    await rm(testRoot, { recursive: true, force: true });
  }
});

function requireJsonObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

function jsonProperty(object: Record<string, unknown>, name: string): unknown {
  return object[name];
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      await readFile(path).then(
        () => true,
        () => false,
      )
    ) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`Timed out waiting for ${path}`);
}
