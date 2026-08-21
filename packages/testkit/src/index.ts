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
  type McpClientTransport,
  type McpTransportFactory,
  type ProjectLifecycleOwner,
  ProjectLifecycleOwnerError,
  type ProjectLifecycleOwnerLease,
  type SessionRecord,
  type SessionStoreDirectory,
  sessionAutomaticTitlesEnabled,
  sessionProjectLifecycleOwner,
  sessionStoreDirectory,
} from "@adam-agent/agent/internal-testing";

export type ScriptedMcpTool = {
  readonly annotations?: Readonly<Record<string, unknown>>;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
};

export type ScriptedMcpToolPage = {
  readonly cursor?: string;
  readonly nextCursor?: string;
  readonly tools: readonly ScriptedMcpTool[];
};

export type ScriptedMcpRequest = {
  readonly method: string;
  readonly params?: unknown;
};

export type ScriptedMcpReply =
  | { readonly kind: "disconnect" }
  | { readonly kind: "error"; readonly code: number; readonly message: string }
  | { readonly kind: "hold" }
  | {
      readonly kind: "result";
      readonly notifyToolsChanged?: boolean;
      readonly result: unknown;
    };

export type ScriptedMcpServer = {
  readonly protocolVersion?: string;
  readonly respond?: (
    request: ScriptedMcpRequest,
    defaultReply: ScriptedMcpReply,
  ) => ScriptedMcpReply | Promise<ScriptedMcpReply>;
  readonly serverName?: string;
  readonly serverVersion?: string;
  readonly toolPages: readonly ScriptedMcpToolPage[];
};

export type ScriptedMcpTransportFactory = McpTransportFactory & {
  disconnect(serverId: string): void;
  nextClose(serverId: string): Promise<void>;
  notifyToolsChanged(serverId: string): void;
  requests(serverId: string): readonly ScriptedMcpRequest[];
};

type McpTransportMessage = Parameters<NonNullable<McpClientTransport["onmessage"]>>[0];
type ScriptedMcpActiveTransport = {
  readonly disconnect: () => void;
  readonly notifyToolsChanged: () => void;
};
type ScriptedMcpTransportState = "closed" | "new" | "started";

export function createScriptedMcpTransportFactory(
  servers: Readonly<Record<string, ScriptedMcpServer>>,
): ScriptedMcpTransportFactory {
  const requests = new Map<string, ScriptedMcpRequest[]>();
  const active = new Map<string, Set<ScriptedMcpActiveTransport>>();
  const closeWaiters = new Map<string, Array<() => void>>();
  return {
    create(input) {
      const script = servers[input.server.serverId];
      if (script === undefined) {
        throw new Error(`No scripted MCP peer exists for ${input.server.serverId}.`);
      }
      const observed = requests.get(input.server.serverId) ?? [];
      requests.set(input.server.serverId, observed);
      let state: ScriptedMcpTransportState = "new";
      let closeEmitted = false;
      const activeForServer = active.get(input.server.serverId) ?? new Set();
      active.set(input.server.serverId, activeForServer);
      const emitClose = () => {
        if (closeEmitted) {
          return;
        }
        closeEmitted = true;
        transport.onclose?.();
        closeWaiters.get(input.server.serverId)?.shift()?.();
      };
      const control: ScriptedMcpActiveTransport = {
        disconnect() {
          if (state === "closed") {
            return;
          }
          state = "closed";
          activeForServer.delete(control);
          emitClose();
          input.onUnexpectedClose();
        },
        notifyToolsChanged() {
          if (state !== "started") {
            throw new Error("The scripted MCP transport must be started before notifications.");
          }
          transport.onmessage?.({
            jsonrpc: "2.0",
            method: "notifications/tools/list_changed",
          } as McpTransportMessage);
        },
      };
      activeForServer.add(control);
      const transport: McpClientTransport = {
        failureKind: undefined,
        get isUsable() {
          return state === "started";
        },
        launchIdentityDigest: input.launch.identityDigest,
        get spawnConfirmed() {
          return state !== "new";
        },
        async start() {
          input.generationSignal.throwIfAborted();
          if (state !== "new") {
            throw new Error(`The scripted MCP transport cannot start from ${state} state.`);
          }
          state = "started";
          input.generationSignal.addEventListener(
            "abort",
            () => {
              void transport.close();
            },
            { once: true },
          );
        },
        async send(message) {
          if (state !== "started") {
            throw new Error(`The scripted MCP transport cannot send from ${state} state.`);
          }
          if (!("method" in message)) {
            return;
          }
          observed.push({
            method: message.method,
            ...("params" in message ? { params: message.params } : {}),
          });
          if (!("id" in message)) {
            return;
          }
          const request = {
            method: message.method,
            ...("params" in message ? { params: message.params } : {}),
          };
          const defaultReply = scriptedMcpReply(script, request);
          const reply = await (script.respond?.(request, defaultReply) ?? defaultReply);
          if (state !== "started") {
            return;
          }
          if (reply.kind === "hold") {
            return;
          }
          if (reply.kind === "disconnect") {
            control.disconnect();
            return;
          }
          queueMicrotask(() => {
            if (state !== "started") {
              return;
            }
            transport.onmessage?.(
              (reply.kind === "error"
                ? {
                    jsonrpc: "2.0",
                    id: message.id,
                    error: { code: reply.code, message: reply.message },
                  }
                : { jsonrpc: "2.0", id: message.id, result: reply.result }) as McpTransportMessage,
            );
            if (reply.kind === "result" && reply.notifyToolsChanged === true) {
              control.notifyToolsChanged();
            }
          });
        },
        async close() {
          if (state === "closed") {
            return;
          }
          state = "closed";
          activeForServer.delete(control);
          emitClose();
        },
      };
      return transport;
    },
    disconnect(serverId) {
      for (const transport of [...(active.get(serverId) ?? [])]) {
        transport.disconnect();
      }
    },
    nextClose(serverId) {
      return new Promise((resolve) => {
        const waiters = closeWaiters.get(serverId) ?? [];
        waiters.push(resolve);
        closeWaiters.set(serverId, waiters);
      });
    },
    notifyToolsChanged(serverId) {
      for (const transport of active.get(serverId) ?? []) {
        transport.notifyToolsChanged();
      }
    },
    requests(serverId) {
      return [...(requests.get(serverId) ?? [])];
    },
  };
}

function scriptedMcpReply(
  script: ScriptedMcpServer,
  request: ScriptedMcpRequest,
): ScriptedMcpReply {
  if (request.method === "initialize") {
    return {
      kind: "result",
      result: {
        protocolVersion: script.protocolVersion ?? "2025-11-25",
        capabilities: { tools: { listChanged: true } },
        serverInfo: {
          name: script.serverName ?? "adam-scripted-mcp-peer",
          version: script.serverVersion ?? "1.0.0",
        },
      },
    };
  }
  if (request.method === "tools/list") {
    const cursor = scriptedMcpCursor(request.params);
    const page = script.toolPages.find((candidate) => candidate.cursor === cursor);
    if (page === undefined) {
      throw new Error(`No scripted MCP tool page exists for cursor ${cursor ?? "<initial>"}.`);
    }
    return {
      kind: "result",
      result: {
        tools: page.tools,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      },
    };
  }
  if (request.method === "tools/call") {
    const call = scriptedMcpCall(request.params);
    const value = call.arguments.value;
    if (call.name !== "echo" || typeof value !== "string") {
      return {
        kind: "result",
        result: {
          content: [{ type: "text", text: "invalid scripted call" }],
          isError: true,
        },
      };
    }
    return {
      kind: "result",
      result: {
        content: [{ type: "text", text: value }],
        structuredContent: { echoed: value },
      },
    };
  }
  throw new Error(`The scripted MCP peer does not handle ${request.method}.`);
}

function scriptedMcpCursor(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null || !("cursor" in params)) {
    return undefined;
  }
  const cursor = params.cursor;
  return typeof cursor === "string" ? cursor : undefined;
}

function scriptedMcpCall(params: unknown): {
  readonly arguments: Readonly<Record<string, unknown>> & { readonly value?: unknown };
  readonly name: string | undefined;
} {
  if (typeof params !== "object" || params === null) {
    return { arguments: {}, name: undefined };
  }
  const name = "name" in params && typeof params.name === "string" ? params.name : undefined;
  const args =
    "arguments" in params && typeof params.arguments === "object" && params.arguments !== null
      ? (params.arguments as Readonly<Record<string, unknown>> & { readonly value?: unknown })
      : {};
  return { arguments: args, name };
}

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
