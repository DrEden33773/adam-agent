import { writeSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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
  createPresentationPreferences,
  createProductionManagedControlComposition,
  createSessionLifecycle,
  createWebSearchConfiguration,
  createWorkspaceTrust,
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

import { type CliCommand, failConfiguration } from "./command.js";

export async function run(command: Exclude<CliCommand, { type: "help" }>): Promise<void> {
  const { XDG_CONFIG_HOME: inheritedUserConfigurationRoot } = process.env;
  const ownerConfigurationRoot =
    inheritedUserConfigurationRoot === undefined || inheritedUserConfigurationRoot.length === 0
      ? join(homedir(), ".config")
      : inheritedUserConfigurationRoot;
  const userConfigurationEnvironment: NodeJS.ProcessEnv = {
    XDG_CONFIG_HOME: isAbsolute(ownerConfigurationRoot)
      ? ownerConfigurationRoot
      : resolve(ownerConfigurationRoot),
  };
  if (command.type !== "recover_operation" && command.type !== "workspace_trust") {
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
    await activeSession.decidePermission({
      requestId: event.requestId,
      decision: answer === "y" ? "allow" : "deny",
    });
  }

  type PermissionDecisionTarget = {
    decidePermission(
      command: PermissionDecisionCommand,
    ): PermissionDecisionCommandResult | Promise<PermissionDecisionCommandResult>;
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
    if (event.subject.type === "plan_command") {
      return `Allow ${event.name} Plan execute at "${event.subject.cwd}": ${quoteForTerminal(event.subject.command)}. Plan parsing is not a sandbox; approval may run project code, write cache or artifacts, read accessible data, or use network. [y/N] `;
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
    if (event.subject.type === "input_resource") {
      return `Allow ${event.name} for linked input resource ${quoteForTerminal(event.subject.occurrenceId)} [y/N] `;
    }
    if (event.subject.type === "managed_agent_action") {
      const envelope = event.subject.envelope;
      return `Allow ${event.subject.action} for the exact selected turns${envelope === undefined ? "" : `: ${envelope.threads} thread, ${envelope.running} running/${envelope.queued} queued, ${envelope.aggregateTokens} tokens; envelope ${envelope.id}`} (${event.subject.argumentsDigest}) [y/N] `;
    }
    if (event.subject.type === "managed_agent_batch") {
      return `Allow ${event.subject.count} ${event.subject.mode} agents for this exact batch: ${event.subject.envelope.running} running/${event.subject.envelope.queued} queued, ${event.subject.envelope.aggregateTokens} tokens; envelope ${event.subject.envelope.id} (${event.subject.argumentsDigest}) [y/N] `;
    }
    if (event.subject.type === "managed_agent_spawn") {
      return `Allow ${event.subject.profile} ${event.subject.mode ?? "foreground"} scout for this exact task${event.subject.sharedTaskBudget?.mode === "limited" ? ` joining agent ${event.subject.shareBudgetWithAgentId}: ${event.subject.sharedTaskBudget.grants.reduce((sum, grant) => sum + grant.tokens, 0)} existing task tokens shared by all members; no tokens added` : ""}${event.subject.budgetTokens === undefined ? "" : ` with ${event.subject.budgetTokens} cumulative tokens shared across attempts`} (${event.subject.taskDigest}) [y/N] `;
    }
    if (event.subject.type === "managed_agent_control") {
      return `Allow managed-child ${event.subject.action} for this exact parent session [y/N] `;
    }
    if (event.subject.type === "parent_coordination") {
      return `Allow managed-child ${event.subject.operation} for its exact owning parent [y/N] `;
    }
    if (event.subject.type === "managed_agent_web_request") {
      return `Allow ${event.subject.agentId} (${event.subject.profile}) to send this exact Web request to ${quoteForTerminal(event.subject.providerOrigin)}: ${quoteForTerminal(event.subject.queryOrUrl)}? [y/N] `;
    }
    if (event.subject.type === "web_request") {
      const target =
        event.subject.operation === "fetch"
          ? event.subject.url
          : `${event.subject.query} (limit ${event.subject.limit}${event.subject.language === undefined ? "" : `, language ${event.subject.language}`}${event.subject.timeRange === undefined ? "" : `, time range ${event.subject.timeRange}`})`;
      return `Allow ${event.name} for this exact Web request to ${quoteForTerminal(event.subject.providerOrigin)}: ${quoteForTerminal(target)} [y/N] `;
    }
    if (event.subject.type === "web_artifact") {
      return `Allow ${event.name} to ${event.subject.operation} immutable Web artifact ${event.subject.artifactId} [y/N] `;
    }
    if (event.subject.type === "session_todo") {
      return `Allow ${event.subject.operation} in session ${quoteForTerminal(event.subject.sessionId)} [y/N] `;
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

  async function runCliCommand(
    activeCommand: Exclude<CliCommand, { type: "help" }>,
  ): Promise<void> {
    try {
      if (activeCommand.type === "workspace_trust") {
        const workspaceTrust = createWorkspaceTrust({
          environment: userConfigurationEnvironment,
          workspaceRoot,
        });
        const current = await workspaceTrust.load();
        if (activeCommand.action === "status") {
          writeText(1, `${JSON.stringify(current)}\n`);
          return;
        }
        if (current.projectId === null || current.diagnostic !== null) {
          writeText(
            2,
            `${current.diagnostic?.message ?? "The canonical workspace identity is unavailable."}\n`,
          );
          process.exitCode = 1;
          return;
        }
        const lifecycle = createSessionLifecycle({
          stateRoot,
          workspaceRoot,
          workspaceTrust,
        });
        let commandSucceeded = false;
        try {
          const result = await lifecycle.configureWorkspaceTrust({
            type: activeCommand.action === "grant" ? "grant" : "revoke",
            projectId: current.projectId,
          });
          writeText(1, `${JSON.stringify(result.snapshot)}\n`);
          commandSucceeded = true;
        } catch (error) {
          writeText(
            2,
            `${error instanceof Error ? error.message : "The workspace trust configuration could not be saved."}\n`,
          );
          process.exitCode = 1;
        } finally {
          const closed = await lifecycle.close();
          if (closed.status !== "closed" && commandSucceeded) {
            writeText(2, "The workspace trust administration runtime did not close safely.\n");
            process.exitCode = 1;
          }
        }
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
      const lifecycle = await createRunLifecycle(modelTargets);
      try {
        if (activeCommand.type === "resume" && !activeCommand.continue) {
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
          const snapshot = await lifecycle.branch({
            parentSessionId: activeCommand.parentSessionId,
            atSequence: activeCommand.atSequence,
            ...(activeCommand.targetId === undefined ? {} : { targetId: activeCommand.targetId }),
          });
          writeText(1, `${JSON.stringify(snapshot)}\n`);
          return;
        }

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
      } finally {
        await closeRunLifecycle(lifecycle);
      }
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

  async function closeRunLifecycle(lifecycle: SessionLifecycle): Promise<void> {
    const closed = await lifecycle.close();
    if (closed.status !== "closed") throw new SessionLifecycleError("mcp_shutdown_unconfirmed");
  }

  async function createRunLifecycle(modelTargets: ModelTargets): Promise<SessionLifecycle> {
    const artifactStore = createLazyFileArtifactStore(join(stateRoot, "artifacts"));
    return createSessionLifecycle({
      managedControl: await createProductionManagedControlComposition({ workspaceRoot, stateRoot }),
      modelTargets,
      preferences: createPresentationPreferences({ environment: userConfigurationEnvironment }),
      workspaceTrust: createWorkspaceTrust({
        environment: userConfigurationEnvironment,
        workspaceRoot,
      }),
      stateRoot,
      webSearchConfiguration: createWebSearchConfiguration({
        environment: userConfigurationEnvironment,
      }),
      workspaceRoot,
      tools: createCodingToolRegistry({ workspaceRoot, stateRoot, artifactStore }),
      permissions: createPermissionPolicy({
        allowedEffects: ["read"],
        askedEffects: ["write", "execute", "delegate"],
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
    const unsubscribeManaged = lifecycle.subscribeManagedAgentEvents?.((notification) => {
      if (
        notification.type !== "child_runtime_event" ||
        notification.event.type !== "tool_permission_requested"
      )
        return;
      const handler = answerPermissionRequest(
        {
          decidePermission: (command) =>
            lifecycle.decideManagedAgentPermission({
              ...command,
              sessionId: notification.parentSessionId,
              threadId: notification.agentId,
              attemptId: notification.attemptId,
            }),
        },
        notification.event,
        permissionInput,
      );
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
      unsubscribeManaged?.();
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
}
