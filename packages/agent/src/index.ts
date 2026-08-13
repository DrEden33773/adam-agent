export type UserInput = {
  readonly text: string;
};

export type ModelMessage = {
  readonly role: "user";
  readonly content: string;
};

export type ModelRequest = {
  readonly messages: readonly ModelMessage[];
};

export type ModelEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "finish"; readonly reason: "stop" };

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
        readonly code: "model_stream_incomplete";
        readonly message: string;
      };
    };

export type RuntimeEvent =
  | { readonly type: "user_message"; readonly text: string }
  | { readonly type: "model_message_started" }
  | { readonly type: "model_message_delta"; readonly text: string }
  | { readonly type: "model_message_completed"; readonly text: string }
  | { readonly type: "session_settled"; readonly result: RunResult };

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export type AgentSessionDependencies = {
  readonly model: ModelDriver;
};

export class AgentSession {
  readonly #listeners = new Set<RuntimeEventListener>();
  readonly #model: ModelDriver;

  constructor(dependencies: AgentSessionDependencies) {
    this.#model = dependencies.model;
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async run(input: UserInput): Promise<RunResult> {
    this.#emit({ type: "user_message", text: input.text });
    this.#emit({ type: "model_message_started" });

    let answer = "";
    let finished = false;
    for await (const event of this.#model.stream({
      messages: [{ role: "user", content: input.text }],
    })) {
      if (event.type === "finish") {
        finished = true;
        break;
      }

      answer += event.text;
      this.#emit({ type: "model_message_delta", text: event.text });
    }

    if (!finished) {
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

    this.#emit({ type: "model_message_completed", text: answer });
    const result: RunResult = { status: "completed", answer };
    this.#emit({ type: "session_settled", result });
    return result;
  }

  #emit(event: RuntimeEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}
