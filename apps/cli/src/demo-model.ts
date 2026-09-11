import type { JsonValue, ModelDriver, ModelEvent, ModelMessage } from "@adam-agent/agent";

/** Deterministic, offline CLI examples selected explicitly with fake.local. */
export function createDemoModel(): ModelDriver {
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
  const fakeResponse = (request: Parameters<ModelDriver["stream"]>[0]): readonly ModelEvent[] => {
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
  };
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

  return {
    async *stream(request) {
      yield* fakeResponse(request);
    },
  };
}
