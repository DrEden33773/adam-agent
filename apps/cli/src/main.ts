#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  AgentSession,
  createCodingToolRegistry,
  createFileArtifactStore,
  createJsonlSessionStore,
  createPermissionPolicy,
  type JsonValue,
  type ModelDriver,
  type ModelMessage,
  OpenAICompatibleModelDriver,
  type RuntimeEvent,
} from "@adam-agent/agent";
import { FakeModelDriver } from "@adam-agent/testkit";

loadProjectEnvironment();
const prompt = process.argv.slice(2).join(" ");
const workspaceRoot = process.cwd();
const { ADAM_AGENT_STATE_ROOT: configuredStateRoot } = process.env;
const stateRoot = configuredStateRoot ?? join(homedir(), ".local", "state", "adam-agent");
const verificationPrompt = "Run the repository verification command";
const verificationCommand = "printf cli-verified";
const promptEscapingPrompt = "Run the prompt escaping command";
const promptEscapingCommand = "printf first\n\u001b[31m\u202ecommand\u009b\u2028forged";
const longVerificationPrompt = "Run the long repository verification command";
const longVerificationCommand =
  "trap '' TERM; printf started > started.txt; sleep 5; printf survived > survived.txt";
const codingTaskPrompt = "Update the demo file and verify it";
const multiFilePatchPrompt = "Apply the demo multi-file patch";
const codingTaskVerificationCommand = 'test "$(cat demo.txt)" = after && printf verified';
const fakeModel = new FakeModelDriver((request) => {
  const latestMessage = request.messages.at(-1);
  if (latestMessage?.role === "user") {
    if (prompt === multiFilePatchPrompt) {
      return [
        { type: "tool_call_start", id: "edit-demo-multi-file", name: "edit_file" },
        {
          type: "tool_call_delta",
          id: "edit-demo-multi-file",
          json: JSON.stringify({
            operations: [
              {
                kind: "update",
                path: "demo.txt",
                edits: [{ oldText: "before", newText: "after" }],
              },
              { kind: "create", path: "added.txt", content: "added\n" },
            ],
          }),
        },
        { type: "tool_call_end", id: "edit-demo-multi-file" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    if (prompt === codingTaskPrompt) {
      return [
        { type: "tool_call_start", id: "edit-demo", name: "edit_file" },
        {
          type: "tool_call_delta",
          id: "edit-demo",
          json: JSON.stringify({
            operations: [
              {
                kind: "update",
                path: "demo.txt",
                edits: [{ oldText: "before", newText: "after" }],
              },
            ],
          }),
        },
        { type: "tool_call_end", id: "edit-demo" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    if (
      prompt === verificationPrompt ||
      prompt === longVerificationPrompt ||
      prompt === promptEscapingPrompt
    ) {
      const command =
        prompt === verificationPrompt
          ? verificationCommand
          : prompt === longVerificationPrompt
            ? longVerificationCommand
            : promptEscapingCommand;
      return [
        { type: "tool_call_start", id: "verify-repository", name: "run_shell" },
        {
          type: "tool_call_delta",
          id: "verify-repository",
          json: JSON.stringify({ command }),
        },
        { type: "tool_call_end", id: "verify-repository" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    return [
      { type: "tool_call_start", id: "read-readme", name: "read_file" },
      { type: "tool_call_delta", id: "read-readme", json: '{"path":"README.md"}' },
      { type: "tool_call_end", id: "read-readme" },
      { type: "finish", reason: "tool_calls" },
    ];
  }
  if (
    prompt === codingTaskPrompt &&
    latestMessage?.role === "tool" &&
    latestMessage.name === "edit_file" &&
    latestMessage.result.status === "completed"
  ) {
    return [
      { type: "tool_call_start", id: "verify-demo", name: "run_shell" },
      {
        type: "tool_call_delta",
        id: "verify-demo",
        json: JSON.stringify({ command: codingTaskVerificationCommand }),
      },
      { type: "tool_call_end", id: "verify-demo" },
      { type: "finish", reason: "tool_calls" },
    ];
  }

  const answer =
    prompt === multiFilePatchPrompt
      ? latestMessage?.role === "tool" && latestMessage.result.status === "completed"
        ? "The demo multi-file patch was applied."
        : "The demo multi-file patch failed."
      : prompt === codingTaskPrompt
        ? codingTaskAnswer(latestMessage)
        : prompt === verificationPrompt ||
            prompt === longVerificationPrompt ||
            prompt === promptEscapingPrompt
          ? verificationAnswer(latestMessage)
          : latestMessage?.role === "tool" && latestMessage.result.status === "completed"
            ? firstReadmeParagraph(latestMessage.result.output)
            : "I could not read README.md.";
  return [
    { type: "text_delta", text: answer },
    { type: "finish", reason: "stop" },
  ];
});
const model: ModelDriver = selectModel();
const store = await createJsonlSessionStore({
  stateRoot,
  workspaceRoot,
  sessionId: randomUUID(),
});
const artifactStore = await createFileArtifactStore({ root: join(stateRoot, "artifacts") });
const session = new AgentSession({
  model,
  store,
  tools: createCodingToolRegistry({ workspaceRoot, stateRoot, artifactStore }),
  permissions: createPermissionPolicy({
    allowedEffects: ["read"],
    askedEffects: ["write", "execute"],
  }),
});
async function answerPermissionRequest(
  activeSession: AgentSession,
  event: Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }>,
  input: PermissionLineReader,
): Promise<void> {
  writeText(2, formatPermissionPrompt(event));
  const answer = await input.next();
  activeSession.decidePermission({
    requestId: event.requestId,
    decision: answer === "y" ? "allow" : "deny",
  });
}

class PermissionLineReader {
  readonly #input: NodeJS.ReadStream;
  readonly #lines: string[] = [];
  readonly #waiters: Array<(line: string | undefined) => void> = [];
  #buffer = "";
  #ended = false;

  constructor(input: NodeJS.ReadStream) {
    this.#input = input;
    input.setEncoding("utf8");
    input.on("data", this.#handleData);
    input.once("end", this.#handleEnd);
  }

  next(): Promise<string | undefined> {
    const line = this.#lines.shift();
    if (line !== undefined) {
      return Promise.resolve(line);
    }
    if (this.#ended) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolvePromise) => this.#waiters.push(resolvePromise));
  }

  close(): void {
    this.#handleEnd();
    this.#input.pause();
    this.#input.removeListener("data", this.#handleData);
    this.#input.removeListener("end", this.#handleEnd);
  }

  readonly #handleData = (chunk: string) => {
    this.#buffer += chunk;
    let lineEnd = this.#buffer.indexOf("\n");
    while (lineEnd !== -1) {
      const line = this.#buffer.slice(0, lineEnd).replace(/\r$/u, "");
      this.#buffer = this.#buffer.slice(lineEnd + 1);
      const waiter = this.#waiters.shift();
      if (waiter === undefined) {
        this.#lines.push(line);
      } else {
        waiter(line);
      }
      lineEnd = this.#buffer.indexOf("\n");
    }
  };

  readonly #handleEnd = () => {
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    this.#buffer = "";
    for (const waiter of this.#waiters.splice(0)) {
      waiter(undefined);
    }
  };
}

const permissionInput = new PermissionLineReader(process.stdin);
const pendingPermissionHandlers = new Set<Promise<void>>();
session.subscribe((event) => {
  if (event.type !== "tool_permission_requested") {
    return;
  }
  const handler = answerPermissionRequest(session, event, permissionInput);
  pendingPermissionHandlers.add(handler);
  void handler.then(
    () => pendingPermissionHandlers.delete(handler),
    () => pendingPermissionHandlers.delete(handler),
  );
});
let interrupted = false;
const handleInterrupt = () => {
  interrupted = true;
  session.abort();
};
process.once("SIGINT", handleInterrupt);

const result = await session.run({ text: prompt }, { limits: { maxTurns: 8 } });
permissionInput.close();
await Promise.allSettled(pendingPermissionHandlers);
process.removeListener("SIGINT", handleInterrupt);

if (result.status === "completed") {
  writeText(1, `${result.answer}\n`);
} else {
  writeText(2, `${result.error.message}\n`);
  process.exitCode = result.status === "cancelled" && interrupted ? 130 : 1;
}

function formatPermissionPrompt(
  event: Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }>,
): string {
  if (event.subject.type === "command") {
    return `Allow ${event.name} at "${event.subject.cwd}": ${quoteForTerminal(event.subject.command)} [y/N] `;
  }
  if (event.subject.type === "patch") {
    const operations = event.subject.operations
      .map((operation) =>
        operation.kind === "move"
          ? `move ${quoteForTerminal(operation.from)} -> ${quoteForTerminal(operation.to)}`
          : `${operation.kind} ${quoteForTerminal(operation.path)}`,
      )
      .join(", ");
    return `Allow ${event.name} patch (${operations}; ${event.subject.digest}) [y/N] `;
  }
  if (event.subject.type === "extension_capability") {
    return `Allow ${event.subject.capabilityId} for extension ${quoteForTerminal(event.subject.extensionId)} operation ${quoteForTerminal(event.subject.operationId)} [y/N] `;
  }
  return `Allow ${event.name} for ${quoteForTerminal(event.subject.path)} [y/N] `;
}

function quoteForTerminal(value: string): string {
  return JSON.stringify(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) =>
    Array.from(
      { length: character.length },
      (_, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, "0")}`,
    ).join(""),
  );
}

function verificationAnswer(message: ModelMessage | undefined): string {
  if (message?.role !== "tool" || message.result.status !== "completed") {
    return "The verification command was not run.";
  }
  const output = message.result.output;
  if (!isJsonObject(output)) {
    return "The verification command returned an invalid result.";
  }
  const stdout = jsonProperty(output, "stdout");
  if (!isJsonObject(stdout)) {
    return "The verification command returned an invalid result.";
  }
  const tail = jsonProperty(stdout, "tail");
  return typeof tail === "string"
    ? `The verification command produced ${tail}.`
    : "The verification command returned an invalid result.";
}

function codingTaskAnswer(message: ModelMessage | undefined): string {
  if (message?.role !== "tool" || message.name !== "run_shell") {
    return "The demo file could not be updated.";
  }
  return shellOutputTail(
    message.result.status === "completed" ? message.result.output : undefined,
  ) === "verified"
    ? "The demo file was updated and verified."
    : "The demo file verification failed.";
}

function shellOutputTail(output: JsonValue | undefined): string | undefined {
  if (!isJsonObject(output)) {
    return undefined;
  }
  const stdout = jsonProperty(output, "stdout");
  if (!isJsonObject(stdout)) {
    return undefined;
  }
  const tail = jsonProperty(stdout, "tail");
  return typeof tail === "string" ? tail : undefined;
}

function firstReadmeParagraph(output: JsonValue): string {
  const content = readFileContent(output);
  return (
    content
      ?.split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#")) ?? "README.md was empty."
  );
}

function readFileContent(output: JsonValue): string | undefined {
  if (!isJsonObject(output)) {
    return undefined;
  }
  const content = jsonProperty(output, "content");
  return typeof content === "string" ? content : undefined;
}

function isJsonObject(
  value: JsonValue | undefined,
): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonProperty(object: { readonly [key: string]: JsonValue }, name: string): JsonValue {
  return object[name] ?? null;
}

function writeText(fileDescriptor: number, text: string): void {
  writeSync(fileDescriptor, text);
}

function selectModel(): ModelDriver {
  const {
    ADAM_AGENT_PROVIDER: provider,
    DEEPSEEK_API_KEY: apiKey,
    ADAM_AGENT_MODEL: configuredModel,
  } = process.env;
  if (provider === undefined) {
    return fakeModel;
  }
  if (provider !== "deepseek") {
    return failConfiguration("ADAM_AGENT_PROVIDER must be unset or deepseek.");
  }
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return failConfiguration("DEEPSEEK_API_KEY is required when ADAM_AGENT_PROVIDER=deepseek.");
  }
  if (configuredModel !== undefined && configuredModel.trim().length === 0) {
    return failConfiguration("ADAM_AGENT_MODEL must be non-empty when set.");
  }
  return new OpenAICompatibleModelDriver({
    profile: "deepseek",
    apiKey,
    baseURL: "https://api.deepseek.com",
    model: configuredModel ?? "deepseek-v4-pro",
    maximumOutputTokens: 32_768,
  });
}

function failConfiguration(message: string): never {
  writeText(2, `${message}\n`);
  process.exit(1);
}

function loadProjectEnvironment(): void {
  try {
    process.loadEnvFile(join(process.cwd(), ".env"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    failConfiguration("Adam Agent could not load the project .env file.");
  }
}
