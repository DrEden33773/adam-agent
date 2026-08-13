import type { ModelDriver, ModelEvent, ModelRequest } from "@adam-agent/agent";

export type FakeModelScript =
  | readonly ModelEvent[]
  | ((request: ModelRequest) => readonly ModelEvent[]);

export class FakeModelDriver implements ModelDriver {
  readonly #script: FakeModelScript;

  constructor(script: FakeModelScript) {
    this.#script = script;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const events = typeof this.#script === "function" ? this.#script(request) : this.#script;
    for (const event of events) {
      yield event;
    }
  }
}
