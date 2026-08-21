import { realpathSync } from "node:fs";

import {
  createSessionLifecycle,
  type ModelDriver,
  type ModelEvent,
  type ModelRequest,
  type SessionLifecycle,
  type SessionLifecycleOptions,
} from "@adam-agent/agent";
import {
  createInMemorySessionStoreDirectory,
  type ProjectLifecycleOwner,
  ProjectLifecycleOwnerError,
  type ProjectLifecycleOwnerLease,
  type SessionRecord,
  type SessionStoreDirectory,
  sessionAutomaticTitlesEnabled,
  sessionProjectLifecycleOwner,
  sessionStoreDirectory,
} from "@adam-agent/agent/internal-testing";

/** Keeps pre-B9 fixtures focused on their original provider/session contract. */
export function createSessionLifecycleForTesting(
  options: SessionLifecycleOptions,
): SessionLifecycle {
  return createSessionLifecycle({ ...options, [sessionAutomaticTitlesEnabled]: false });
}

export function createInMemorySessionLifecycleHarness(): {
  readonly acquireOwner: () => Promise<ProjectLifecycleOwnerLease>;
  readonly createLifecycle: (options: SessionLifecycleOptions) => SessionLifecycle;
  readonly sessions: SessionStoreDirectory<SessionRecord>;
} {
  const directory = createInMemorySessionStoreDirectory<SessionRecord>();
  const owner = createInMemoryProjectLifecycleOwner();
  let canonicalWorkspaceRoot: string | undefined;
  return {
    acquireOwner: () => owner.acquire(),
    createLifecycle(options) {
      const requestedCanonicalRoot = realpathSync(options.workspaceRoot);
      canonicalWorkspaceRoot ??= requestedCanonicalRoot;
      if (canonicalWorkspaceRoot !== requestedCanonicalRoot) {
        throw new TypeError("One in-memory lifecycle harness may own only one workspace root.");
      }
      return createSessionLifecycle({
        ...options,
        [sessionAutomaticTitlesEnabled]: false,
        [sessionProjectLifecycleOwner]: owner,
        [sessionStoreDirectory]: directory,
      });
    },
    sessions: directory,
  };
}

function createInMemoryProjectLifecycleOwner(): ProjectLifecycleOwner {
  let held = false;
  const acquire = async (): Promise<ProjectLifecycleOwnerLease> => {
    if (held) {
      throw new ProjectLifecycleOwnerError("project_in_use");
    }
    held = true;
    let released = false;
    return {
      async release() {
        if (released) {
          return;
        }
        released = true;
        held = false;
      },
    };
  };
  return {
    acquire,
    async run(operation) {
      const lease = await acquire();
      try {
        return await operation();
      } finally {
        await lease.release();
      }
    },
  };
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
