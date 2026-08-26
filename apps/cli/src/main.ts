#!/usr/bin/env node

import { writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  type ArtifactStore,
  type ContextProfile,
  createBiomeExecutionAdapter,
  createCodingToolRegistry,
  createExtensionHost,
  createFileArtifactStore,
  createJsonlOperationStore,
  createModelTargets,
  createPermissionPolicy,
  createSessionLifecycle,
  ExtensionConfigurationError,
  ExtensionHostError,
  type JsonValue,
  loadExtensionConfiguration,
  type ModelMessage,
  ModelTargetError,
  type ModelTargetIdentity,
  type ModelTargets,
  OperationHostError,
  type PermissionDecisionCommand,
  type PermissionDecisionCommandResult,
  type RuntimeEvent,
  type SessionLifecycle,
  SessionLifecycleError,
  selectModelTargetId,
} from "@adam-agent/agent";
import { FakeModelDriver } from "@adam-agent/testkit";

const command = parseCliCommand(process.argv.slice(2));
if (command.type !== "help" && command.type !== "recover_operation") {
  loadProjectEnvironment();
}
const workspaceRoot = process.cwd();
const { ADAM_AGENT_STATE_ROOT: configuredStateRoot } = process.env;
const stateRoot = configuredStateRoot ?? join(homedir(), ".local", "state", "adam-agent");
const verificationPrompt = "Run the repository verification command";
const verificationCommand = "printf cli-verified";
const promptEscapingPrompt = "Run the prompt escaping command";
const promptEscapingCommand = "printf first\n\u001b[31m\u202ecommand\u009b\u2028forged";
const longVerificationPrompt = "Run the long repository verification command";
const longVerificationCommand = "trap '' TERM; printf started > started.txt; tail -f /dev/null";
const codingTaskPrompt = "Update the demo file and verify it";
const multiFilePatchPrompt = "Apply the demo multi-file patch";
const truncatedAnswerPrompt = "Return a deliberately truncated answer";
const codingTaskVerificationCommand = 'test "$(cat demo.txt)" = after && printf verified';
const fakeTargetIdentity: ModelTargetIdentity = {
  targetId: "fake.local",
  vendor: "adam",
  modelId: "fake-local",
  route: "direct",
  profileVersion: 1,
  certification: "certified",
};
const fakeContextProfile: ContextProfile = {
  version: 1,
  contextWindowTokens: 32_768,
  maximumOutputTokens: 4_096,
  compactAtTokens: 24_576,
  postCompactTargetTokens: 8_192,
  retainedTargetTokens: 4_096,
  estimatorVersion: 1,
};
const fakeModel = new FakeModelDriver((request) => {
  const prompt = request.messages.findLast((message) => message.role === "user")?.content ?? "";
  const latestMessage = request.messages.at(-1);
  if (latestMessage?.role === "user") {
    if (prompt === truncatedAnswerPrompt) {
      return [
        { type: "text_delta", text: "Partial answer." },
        { type: "finish", reason: "length" },
      ];
    }
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
async function answerPermissionRequest(
  activeSession: PermissionDecisionTarget,
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

type PermissionDecisionTarget = {
  decidePermission(command: PermissionDecisionCommand): PermissionDecisionCommandResult;
};

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

await runCliCommand(command);

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
  if (event.subject.type === "skill") {
    const resource =
      event.subject.path === undefined ? "" : ` resource ${quoteForTerminal(event.subject.path)}`;
    return `Allow ${event.name} for Agent Skill ${quoteForTerminal(event.subject.qualifiedId)}${resource} [y/N] `;
  }
  if (event.subject.type === "mcp_tool") {
    return `Allow ${event.name} from MCP server ${quoteForTerminal(event.subject.serverId)} [y/N] `;
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

type CliCommand =
  | { readonly type: "help" }
  | { readonly type: "prompt"; readonly prompt: string; readonly skills?: readonly string[] }
  | { readonly type: "recover_operation"; readonly operationId: string }
  | { readonly type: "resume"; readonly sessionId: string; readonly continue: boolean }
  | {
      readonly type: "branch";
      readonly parentSessionId: string;
      readonly atSequence: number;
      readonly targetId?: string;
    };

async function runCliCommand(activeCommand: CliCommand): Promise<void> {
  try {
    if (activeCommand.type === "help") {
      writeText(1, `${cliUsage()}\n`);
      return;
    }
    if (activeCommand.type === "recover_operation") {
      const extensions = await loadExtensionConfiguration(process.env);
      const artifactStore = await createFileArtifactStore({ root: join(stateRoot, "artifacts") });
      const operationStore = await createJsonlOperationStore({ stateRoot, workspaceRoot });
      const host = createExtensionHost({
        artifactStore,
        biomeExecution: createBiomeExecutionAdapter(),
        capabilities: [
          { id: "adam.analyzer-execution.biome@1", version: "1.0.0" },
          { id: "adam.artifact.publish@1", version: "1.0.0" },
          { id: "adam.storage.records@1", version: "1.0.0" },
        ],
        extensions,
        operationStore,
        permissions: createPermissionPolicy({ allowedEffects: [] }),
        projectRoot: workspaceRoot,
        stateRoot,
      });
      await host.loadConfiguredExtensions();
      const recovered = await host.operations.recover(activeCommand.operationId);
      writeText(1, `${JSON.stringify(recovered)}\n`);
      return;
    }
    const modelTargets = createCliModelTargets();
    if (activeCommand.type === "resume" && !activeCommand.continue) {
      const lifecycle = await createRunLifecycle(modelTargets);
      const resumed = await lifecycle.resume({ sessionId: activeCommand.sessionId });
      if (resumed.status === "rejected") {
        writeText(2, `${resumed.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      writeText(1, `${JSON.stringify(resumed.snapshot)}\n`);
      return;
    }
    if (activeCommand.type === "branch") {
      const lifecycle = await createRunLifecycle(modelTargets);
      const snapshot = await lifecycle.branch({
        parentSessionId: activeCommand.parentSessionId,
        atSequence: activeCommand.atSequence,
        ...(activeCommand.targetId === undefined ? {} : { targetId: activeCommand.targetId }),
      });
      writeText(1, `${JSON.stringify(snapshot)}\n`);
      return;
    }

    const lifecycle = await createRunLifecycle(modelTargets);
    if (activeCommand.type === "prompt") {
      const targetId = selectModelTargetId(process.env);
      const resolved = await modelTargets.resolve({
        targetId,
        allowExperimental: false,
        signal: new AbortController().signal,
      });
      await admitAndPresent(lifecycle, {
        targetIdentity: resolved.identity,
        input: {
          text: activeCommand.prompt,
          ...(activeCommand.skills === undefined ? {} : { skills: activeCommand.skills }),
        },
        limits: { maxTurns: 8 },
      });
      return;
    }
    await continueAndPresent(lifecycle, { sessionId: activeCommand.sessionId });
  } catch (error) {
    if (
      error instanceof ExtensionConfigurationError ||
      error instanceof ExtensionHostError ||
      error instanceof ModelTargetError ||
      error instanceof OperationHostError ||
      error instanceof SessionLifecycleError
    ) {
      writeText(2, `${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

async function createRunLifecycle(modelTargets: ModelTargets): Promise<SessionLifecycle> {
  const artifactStore = createLazyFileArtifactStore(join(stateRoot, "artifacts"));
  return createSessionLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    tools: createCodingToolRegistry({ workspaceRoot, stateRoot, artifactStore }),
    permissions: createPermissionPolicy({
      allowedEffects: ["read"],
      askedEffects: ["write", "execute"],
    }),
  });
}

function createLazyFileArtifactStore(root: string): ArtifactStore {
  let store: Promise<ArtifactStore> | undefined;
  const resolveStore = () => {
    store ??= createFileArtifactStore({ root });
    return store;
  };
  return {
    async write(input) {
      return (await resolveStore()).write(input);
    },
    async read(id) {
      return (await resolveStore()).read(id);
    },
  };
}

async function continueAndPresent(
  lifecycle: SessionLifecycle,
  input: Parameters<SessionLifecycle["continue"]>[0],
): Promise<void> {
  return runAndPresent(lifecycle, (signal) => lifecycle.continue({ ...input, signal }));
}

async function admitAndPresent(
  lifecycle: SessionLifecycle,
  input: Parameters<SessionLifecycle["admit"]>[0],
): Promise<void> {
  return runAndPresent(lifecycle, (signal) => lifecycle.admit({ ...input, signal }));
}

async function runAndPresent(
  lifecycle: SessionLifecycle,
  run: (signal: AbortSignal) => ReturnType<SessionLifecycle["continue"]>,
): Promise<void> {
  const permissionInput = new PermissionLineReader(process.stdin);
  const pendingPermissionHandlers = new Set<Promise<void>>();
  const unsubscribe = lifecycle.subscribe((event) => {
    if (event.type !== "tool_permission_requested") {
      return;
    }
    const handler = answerPermissionRequest(lifecycle, event, permissionInput);
    pendingPermissionHandlers.add(handler);
    void handler.then(
      () => pendingPermissionHandlers.delete(handler),
      () => pendingPermissionHandlers.delete(handler),
    );
  });
  let interrupted = false;
  const abortController = new AbortController();
  const handleInterrupt = () => {
    interrupted = true;
    abortController.abort();
  };
  process.once("SIGINT", handleInterrupt);
  try {
    const continued = await run(abortController.signal);
    if (continued.result.status === "completed" || continued.result.status === "incomplete") {
      writeText(1, `${continued.result.answer}\n`);
      if (continued.result.status === "incomplete") {
        process.exitCode = 1;
      }
    } else {
      writeText(2, `${continued.result.error.message}\n`);
      process.exitCode = continued.result.status === "cancelled" && interrupted ? 130 : 1;
    }
  } finally {
    permissionInput.close();
    await Promise.allSettled(pendingPermissionHandlers);
    process.removeListener("SIGINT", handleInterrupt);
    unsubscribe();
  }
}

function createCliModelTargets(): ModelTargets {
  const configured = createModelTargets({ environment: process.env });
  return {
    async resolve(input) {
      if (input.targetId === fakeTargetIdentity.targetId) {
        return {
          identity: fakeTargetIdentity,
          driver: fakeModel,
          contextProfile: fakeContextProfile,
        };
      }
      return configured.resolve(input);
    },
    async snapshot(input) {
      const snapshot = await configured.snapshot(input);
      return {
        targets: [
          ...snapshot.targets,
          {
            identity: fakeTargetIdentity,
            readiness: { status: "available", credentialSource: "built-in test fixture" },
            contextProfile: fakeContextProfile,
          },
        ],
      };
    },
  };
}

function parseCliCommand(arguments_: readonly string[]): CliCommand {
  if (arguments_.length === 1 && (arguments_[0] === "--help" || arguments_[0] === "-h")) {
    return { type: "help" };
  }
  if (arguments_[0] === "--recover-operation") {
    const operationId = arguments_[1];
    if (
      operationId === undefined ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        operationId,
      ) ||
      arguments_.length !== 2
    ) {
      return failConfiguration("Usage: adam-agent --recover-operation <operation-id>");
    }
    return { type: "recover_operation", operationId };
  }
  if (arguments_[0] === "--resume") {
    const sessionId = arguments_[1];
    const tail = arguments_.slice(2);
    if (
      sessionId === undefined ||
      sessionId.length === 0 ||
      (tail.length !== 0 && !(tail.length === 1 && tail[0] === "--continue"))
    ) {
      return failConfiguration("Usage: adam-agent --resume <session-id> [--continue]");
    }
    return { type: "resume", sessionId, continue: tail[0] === "--continue" };
  }
  if (arguments_[0] === "--branch") {
    const parentSessionId = arguments_[1];
    const atFlag = arguments_[2];
    const atValue = arguments_[3];
    const atSequence = Number(atValue);
    const optionalTail = arguments_.slice(4);
    const validTargetTail =
      optionalTail.length === 0 ||
      (optionalTail.length === 2 &&
        optionalTail[0] === "--target" &&
        optionalTail[1] !== undefined &&
        optionalTail[1].length > 0);
    if (
      parentSessionId === undefined ||
      parentSessionId.length === 0 ||
      atFlag !== "--at" ||
      !Number.isSafeInteger(atSequence) ||
      atSequence <= 0 ||
      !validTargetTail
    ) {
      return failConfiguration(
        "Usage: adam-agent --branch <parent-session-id> --at <event-position> [--target <target-id>]",
      );
    }
    const targetId = optionalTail[1];
    return {
      type: "branch",
      parentSessionId,
      atSequence,
      ...(targetId === undefined ? {} : { targetId }),
    };
  }
  const skills: string[] = [];
  let promptStart = 0;
  while (arguments_[promptStart] === "--skill") {
    const selection = arguments_[promptStart + 1];
    if (selection === undefined || selection === "--skill") {
      return failConfiguration("Usage: adam-agent [--skill <id-or-unique-short-name>]... <prompt>");
    }
    if (Buffer.byteLength(selection, "utf8") > 16_384 || !/^[\x20-\x7e]+$/u.test(selection)) {
      return failConfiguration(
        "Explicit Skill selections must be a bounded list of nonempty ASCII handles.",
      );
    }
    skills.push(selection);
    if (skills.length > 8) {
      return failConfiguration(
        "Explicit Skill selections must be a bounded list of nonempty ASCII handles.",
      );
    }
    promptStart += 2;
  }
  return {
    type: "prompt",
    prompt: arguments_.slice(promptStart).join(" "),
    ...(skills.length === 0 ? {} : { skills }),
  };
}

function cliUsage(): string {
  return [
    "Adam Agent headless CLI",
    "Status: Linux source checkout; application packages are private and not an npm or binary distribution.",
    "",
    "Usage: adam-agent <prompt>",
    "       adam-agent [--skill <id-or-unique-short-name>]... <prompt>",
    "       adam-agent --resume <session-id> [--continue]",
    "       adam-agent --branch <parent-session-id> --at <event-position> [--target <target-id>]",
    "       adam-agent --recover-operation <operation-id>",
    "       adam-agent --help | -h",
    "",
    "From a source checkout:",
    '  ADAM_AGENT_TARGET=fake.local pnpm --silent adam "<prompt>"',
    "  pnpm tui",
    "",
    "--resume without --continue hydrates only; --continue explicitly starts another attempt.",
    "Final answers use stdout; approvals and errors use stderr.",
    "Approvals and built-in path confinement are not an OS, process, or network sandbox.",
    "Review every shell command before approving it.",
  ].join("\n");
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
