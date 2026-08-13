import type {
  ModelToolDefinition,
  PermissionPolicy,
  ToolCall,
  ToolRegistry,
  ToolResult,
} from "./tool-runtime.js";

export {
  createPermissionPolicy,
  createReadToolRegistry,
  type JsonValue,
  type ModelToolDefinition,
  type PermissionDecision,
  type PermissionPolicy,
  type ToolCall,
  type ToolEffect,
  type ToolRegistry,
  type ToolResult,
} from "./tool-runtime.js";

export type UserInput = {
  readonly text: string;
};

export type ModelMessage =
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls: readonly ToolCall[];
    }
  | {
      readonly role: "tool";
      readonly callId: string;
      readonly name: string;
      readonly result: ToolResult;
    };

export type ModelRequest = {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
};

export type ModelEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "tool_call_start"; readonly id: string; readonly name: string }
  | { readonly type: "tool_call_delta"; readonly id: string; readonly json: string }
  | { readonly type: "tool_call_end"; readonly id: string }
  | { readonly type: "finish"; readonly reason: "stop" | "tool_calls" };

export interface ModelDriver {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

export type RunResult =
  | {
      readonly status: "completed";
      readonly answer: string;
    }
  | {
      readonly status: "failed";
      readonly error: {
        readonly code: "model_stream_incomplete" | "model_protocol_invalid";
        readonly message: string;
      };
    };

export type RuntimeEvent =
  | { readonly type: "user_message"; readonly text: string }
  | { readonly type: "model_message_started" }
  | { readonly type: "model_message_delta"; readonly text: string }
  | { readonly type: "model_message_completed"; readonly text: string }
  | { readonly type: "tool_requested"; readonly callId: string; readonly name: string }
  | {
      readonly type: "tool_permission_decided";
      readonly callId: string;
      readonly name: string;
      readonly decision: "allow" | "deny";
    }
  | { readonly type: "tool_started"; readonly callId: string; readonly name: string }
  | {
      readonly type: "tool_completed";
      readonly callId: string;
      readonly name: string;
      readonly output: Extract<ToolResult, { readonly status: "completed" }>["output"];
    }
  | {
      readonly type: "tool_failed";
      readonly callId: string;
      readonly name: string;
      readonly error: Extract<ToolResult, { readonly status: "failed" }>["error"];
    }
  | { readonly type: "session_settled"; readonly result: RunResult };

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export type AgentSessionDependencies = {
  readonly model: ModelDriver;
  readonly tools?: ToolRegistry;
  readonly permissions?: PermissionPolicy;
};

export class AgentSession {
  readonly #listeners = new Set<RuntimeEventListener>();
  readonly #model: ModelDriver;
  readonly #tools: ToolRegistry | undefined;
  readonly #permissions: PermissionPolicy | undefined;

  constructor(dependencies: AgentSessionDependencies) {
    this.#model = dependencies.model;
    this.#tools = dependencies.tools;
    this.#permissions = dependencies.permissions;
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async run(input: UserInput): Promise<RunResult> {
    this.#emit({ type: "user_message", text: input.text });
    const messages: ModelMessage[] = [{ role: "user", content: input.text }];
    const toolResultsById = new Map<
      string,
      { readonly call: ToolCall; readonly result: ToolResult }
    >();

    while (true) {
      this.#emit({ type: "model_message_started" });
      let answer = "";
      let finishReason: "stop" | "tool_calls" | undefined;
      let protocolError: string | undefined;
      const assemblingCalls = new Map<string, ToolCall>();
      const completedCalls: ToolCall[] = [];

      for await (const event of this.#model.stream({
        messages: [...messages],
        tools: this.#tools?.definitions() ?? [],
      })) {
        switch (event.type) {
          case "text_delta":
            answer += event.text;
            this.#emit({ type: "model_message_delta", text: event.text });
            break;
          case "tool_call_start":
            if (assemblingCalls.has(event.id)) {
              protocolError = "The model started the same tool call more than once.";
            } else {
              assemblingCalls.set(event.id, {
                id: event.id,
                name: event.name,
                argumentsJson: "",
              });
            }
            break;
          case "tool_call_delta": {
            const call = assemblingCalls.get(event.id);
            if (call === undefined) {
              protocolError = "The model sent arguments for a tool call that was not started.";
            } else {
              assemblingCalls.set(event.id, {
                ...call,
                argumentsJson: call.argumentsJson + event.json,
              });
            }
            break;
          }
          case "tool_call_end": {
            const call = assemblingCalls.get(event.id);
            if (call === undefined) {
              protocolError = "The model ended a tool call that was not started.";
            } else {
              completedCalls.push(call);
              assemblingCalls.delete(event.id);
            }
            break;
          }
          case "finish":
            finishReason = event.reason;
            break;
        }
        if (finishReason !== undefined) {
          break;
        }
      }

      if (finishReason === undefined) {
        return this.#settleIncompleteStream();
      }

      if (protocolError !== undefined) {
        return this.#settleProtocolInvalid(protocolError);
      }

      this.#emit({ type: "model_message_completed", text: answer });
      if (finishReason === "stop") {
        if (completedCalls.length > 0 || assemblingCalls.size > 0) {
          return this.#settleProtocolInvalid(
            completedCalls.length > 0
              ? "The model stopped after completing a tool request."
              : "The model stopped with an incomplete tool request.",
          );
        }
        const result: RunResult = { status: "completed", answer };
        this.#emit({ type: "session_settled", result });
        return result;
      }

      if (assemblingCalls.size > 0) {
        return this.#settleProtocolInvalid("The model finished with an incomplete tool request.");
      }

      if (completedCalls.length === 0) {
        const result: RunResult = {
          status: "failed",
          error: {
            code: "model_protocol_invalid",
            message: "The model reported tool calls without a completed request.",
          },
        };
        this.#emit({ type: "session_settled", result });
        return result;
      }

      const uniqueCalls = new Map<string, ToolCall>();
      for (const call of completedCalls) {
        const priorCall = uniqueCalls.get(call.id);
        if (priorCall !== undefined) {
          return this.#settleProtocolInvalid(
            priorCall.name !== call.name || priorCall.argumentsJson !== call.argumentsJson
              ? "The model reused a tool call ID with different input."
              : "The model repeated a tool call ID within one turn.",
          );
        }
        uniqueCalls.set(call.id, call);
      }

      messages.push({ role: "assistant", content: answer, toolCalls: completedCalls });
      for (const call of uniqueCalls.values()) {
        this.#emit({ type: "tool_requested", callId: call.id, name: call.name });
        const recordedCall = toolResultsById.get(call.id);
        if (recordedCall !== undefined) {
          if (
            recordedCall.call.name !== call.name ||
            recordedCall.call.argumentsJson !== call.argumentsJson
          ) {
            return this.#settleProtocolInvalid(
              "The model reused a tool call ID with different input.",
            );
          }
          this.#appendToolResult(messages, call, recordedCall.result);
          continue;
        }
        const adapter = this.#tools?.resolve(call.name);
        if (adapter === undefined) {
          const result: ToolResult = {
            status: "failed",
            error: {
              code: "unknown_tool",
              message: `Unknown tool: ${call.name}`,
            },
          };
          toolResultsById.set(call.id, { call, result });
          this.#appendToolResult(messages, call, result);
          continue;
        }
        const preparedCall = adapter.prepare(call.argumentsJson);
        if (preparedCall.status === "failed") {
          toolResultsById.set(call.id, { call, result: preparedCall });
          this.#appendToolResult(messages, call, preparedCall);
          continue;
        }
        const decision = this.#permissions?.decide(adapter.effect) ?? "deny";
        this.#emit({
          type: "tool_permission_decided",
          callId: call.id,
          name: call.name,
          decision,
        });
        if (decision !== "allow") {
          const result: ToolResult = {
            status: "failed",
            error: {
              code: "permission_denied",
              message: `Permission denied for tool: ${call.name}`,
            },
          };
          toolResultsById.set(call.id, { call, result });
          this.#appendToolResult(messages, call, result);
          continue;
        }
        this.#emit({ type: "tool_started", callId: call.id, name: call.name });
        const result = await preparedCall.execute();
        toolResultsById.set(call.id, { call, result });
        this.#appendToolResult(messages, call, result);
      }
    }
  }

  #settleIncompleteStream(): RunResult {
    const result: RunResult = {
      status: "failed",
      error: {
        code: "model_stream_incomplete",
        message: "The model stream ended without a finish event.",
      },
    };
    this.#emit({ type: "session_settled", result });
    return result;
  }

  #settleProtocolInvalid(message: string): RunResult {
    const result: RunResult = {
      status: "failed",
      error: { code: "model_protocol_invalid", message },
    };
    this.#emit({ type: "session_settled", result });
    return result;
  }

  #appendToolResult(messages: ModelMessage[], call: ToolCall, result: ToolResult): void {
    if (result.status === "completed") {
      this.#emit({
        type: "tool_completed",
        callId: call.id,
        name: call.name,
        output: result.output,
      });
    } else {
      this.#emit({
        type: "tool_failed",
        callId: call.id,
        name: call.name,
        error: result.error,
      });
    }
    messages.push({ role: "tool", callId: call.id, name: call.name, result });
  }

  #emit(event: RuntimeEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}
