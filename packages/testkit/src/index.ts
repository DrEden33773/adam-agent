import {
  createSessionLifecycle,
  type ModelDriver,
  type ModelEvent,
  type ModelRequest,
  type SessionLifecycle,
  type SessionLifecycleOptions,
} from "@adam-agent/agent";
import { sessionAutomaticTitlesEnabled } from "@adam-agent/agent/internal-testing";

/** Keeps pre-B9 fixtures focused on their original provider/session contract. */
export function createSessionLifecycleForTesting(
  options: SessionLifecycleOptions,
): SessionLifecycle {
  return createSessionLifecycle({ ...options, [sessionAutomaticTitlesEnabled]: false });
}

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
