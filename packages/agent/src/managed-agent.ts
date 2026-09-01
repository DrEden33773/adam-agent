import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { AgentSession, sessionInitialThinkingPolicy } from "./agent-session.js";
import type { ModelDriver, ModelMessage } from "./agent-session-contracts.js";
import type { ArtifactReference, ArtifactStore } from "./artifact-store.js";
import type { ContextProfile } from "./context-profile.js";
import { scoutManagedAgentProfileV1 } from "./managed-agent-profiles.js";
import type { ModelTargetIdentity } from "./model-targets.js";
import type { ProjectExecutionRootClaim } from "./project-execution-domain.js";
import { createPromptContextV1, type PromptContextRecord } from "./prompt-assembly.js";
import { sessionDurableContext } from "./session-durable-context.js";
import type { SessionRecord, SessionStore, SessionStoreDirectory } from "./session-store.js";
import type { ThinkingPolicySnapshotV1 } from "./thinking-policy.js";
import {
  createInternalToolAdapter,
  createInternalToolRegistry,
  createReadToolRegistry,
  type JsonValue,
  type PermissionPolicy,
  type ToolRegistry,
  type ToolResult,
} from "./tool-runtime.js";

const maximumManagedAgentTaskBytes = 16 * 1024;
const maximumManagedAgentResultBytes = 16 * 1024;
const managedAgentTaskSchema = z.strictObject({
  task: z
    .string()
    .min(1)
    .refine((task) => Buffer.byteLength(task, "utf8") <= maximumManagedAgentTaskBytes),
});
const targetIdentitySchema = z.strictObject({
  targetId: z.string(),
  vendor: z.string(),
  modelId: z.string(),
  route: z.enum(["direct", "vercel-ai-gateway"]),
  upstreamProviderId: z.string().optional(),
  profileVersion: z.number().int().positive(),
  certification: z.enum(["certified", "experimental"]),
});
const thinkingPolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestedLevelId: z.string(),
  effectiveLevelId: z.string(),
  capability: z.strictObject({
    id: z.string(),
    version: z.literal(1),
    digest: z.string().startsWith("sha256:"),
  }),
  mapping: z.discriminatedUnion("thinkingType", [
    z.strictObject({
      requestPath: z.enum(["provider_options.deepseek", "reasoning.effort"]),
      thinkingType: z.literal("disabled"),
    }),
    z.strictObject({
      requestPath: z.enum(["provider_options.deepseek", "reasoning.effort"]),
      thinkingType: z.literal("enabled"),
      reasoningEffort: z.enum(["low", "high", "max"]),
    }),
  ]),
  reasoningArtifact: z.literal("provider_reasoning"),
});
const managedAgentTerminalOutputSchema = z.strictObject({
  agentId: z.string().uuid(),
  attemptId: z.string().uuid(),
  profile: z.literal("scout.v1"),
  status: z.literal("completed"),
  result: z.union([
    z.strictObject({ text: z.string() }),
    z.strictObject({
      artifact: z.strictObject({
        id: z.string().startsWith("sha256:"),
        mediaType: z.literal("text/plain; charset=utf-8"),
        byteCount: z.number().int().positive(),
      }),
    }),
  ]),
  targetIdentity: targetIdentitySchema,
  thinkingPolicy: thinkingPolicySchema.optional(),
  usage: z.strictObject({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
  }),
  cost: z.strictObject({ status: z.literal("unavailable") }),
  transcript: z.strictObject({
    sessionId: z.string().uuid(),
    digest: z.string().startsWith("sha256:"),
    throughSequence: z.number().int().nonnegative(),
  }),
});

export type ManagedAgentRecord =
  | {
      readonly schemaVersion: 1;
      readonly type: "managed_agent_admitted";
      readonly sequence: number;
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly parentSessionId: string;
      readonly parentToolCallId: string;
      readonly parentRootId: string;
      readonly projectId: `sha256:${string}`;
      readonly profile: "scout.v1";
      readonly taskDigest: `sha256:${string}`;
      readonly targetIdentity: ModelTargetIdentity;
      readonly thinkingPolicy?: ThinkingPolicySnapshotV1;
      readonly repository?: {
        readonly revision: number;
        readonly effectiveDigest: `sha256:${string}`;
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "managed_agent_terminal";
      readonly sequence: number;
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly status: "completed";
      readonly result:
        | { readonly text: string }
        | {
            readonly artifact: Pick<ArtifactReference, "id" | "mediaType" | "byteCount">;
          };
      readonly transcriptDigest: `sha256:${string}`;
      readonly throughSequence: number;
      readonly usage: {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly reasoningTokens: number;
      };
      readonly cost: { readonly status: "unavailable" };
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "managed_agent_terminal";
      readonly sequence: number;
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly status: "failed";
      readonly error: { readonly code: string; readonly message: string };
      readonly transcriptDigest: `sha256:${string}`;
      readonly throughSequence: number;
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "managed_agent_terminal";
      readonly sequence: number;
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly status: "cancelled";
      readonly reason: "caller";
      readonly transcriptDigest: `sha256:${string}`;
      readonly throughSequence: number;
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "managed_agent_terminal";
      readonly sequence: number;
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly status: "recovery_required";
      readonly error: {
        readonly code: "managed_agent_recovery_required";
        readonly message: string;
      };
    };

type ManagedAgentRecordInput = ManagedAgentRecord extends infer RecordType
  ? RecordType extends ManagedAgentRecord
    ? Omit<RecordType, "schemaVersion" | "sequence">
    : never
  : never;

export type ManagedAgentStore = {
  append(record: ManagedAgentRecord): Promise<void>;
  read(): Promise<readonly ManagedAgentRecord[]>;
};

export class ManagedAgentStoreError extends Error {
  readonly code: "managed_agent_log_invalid" | "managed_agent_log_too_large";

  constructor(code: ManagedAgentStoreError["code"]) {
    super(
      code === "managed_agent_log_too_large"
        ? "The Managed Agent lifecycle log exceeds its bound."
        : "The Managed Agent lifecycle log is invalid.",
    );
    this.name = "ManagedAgentStoreError";
    this.code = code;
  }
}

const managedAgentRecordSchema = z.union([
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("managed_agent_admitted"),
    sequence: z.number().int().positive(),
    agentId: z.uuid(),
    attemptId: z.uuid(),
    childSessionId: z.uuid(),
    parentSessionId: z.uuid(),
    parentToolCallId: z.string().min(1).max(256),
    parentRootId: z.string().min(1).max(256),
    projectId: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    profile: z.literal("scout.v1"),
    taskDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    targetIdentity: targetIdentitySchema,
    thinkingPolicy: thinkingPolicySchema.optional(),
    repository: z
      .strictObject({
        revision: z.number().int().positive(),
        effectiveDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
      })
      .optional(),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("managed_agent_terminal"),
    sequence: z.number().int().positive(),
    agentId: z.uuid(),
    attemptId: z.uuid(),
    childSessionId: z.uuid(),
    status: z.literal("completed"),
    result: z.union([
      z.strictObject({
        text: z.string().refine((text) => Buffer.byteLength(text, "utf8") <= 16 * 1024),
      }),
      z.strictObject({
        artifact: z.strictObject({
          id: z.string().startsWith("sha256:"),
          mediaType: z.literal("text/plain; charset=utf-8"),
          byteCount: z.number().int().positive(),
        }),
      }),
    ]),
    transcriptDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    throughSequence: z.number().int().nonnegative(),
    usage: z.strictObject({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      reasoningTokens: z.number().int().nonnegative(),
    }),
    cost: z.strictObject({ status: z.literal("unavailable") }),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("managed_agent_terminal"),
    sequence: z.number().int().positive(),
    agentId: z.uuid(),
    attemptId: z.uuid(),
    childSessionId: z.uuid(),
    status: z.literal("failed"),
    error: z.strictObject({
      code: z.string().min(1).max(128),
      message: z.string().min(1).max(4_096),
    }),
    transcriptDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    throughSequence: z.number().int().nonnegative(),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("managed_agent_terminal"),
    sequence: z.number().int().positive(),
    agentId: z.uuid(),
    attemptId: z.uuid(),
    childSessionId: z.uuid(),
    status: z.literal("cancelled"),
    reason: z.literal("caller"),
    transcriptDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    throughSequence: z.number().int().nonnegative(),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("managed_agent_terminal"),
    sequence: z.number().int().positive(),
    agentId: z.uuid(),
    attemptId: z.uuid(),
    childSessionId: z.uuid(),
    status: z.literal("recovery_required"),
    error: z.strictObject({
      code: z.literal("managed_agent_recovery_required"),
      message: z.string().min(1).max(4_096),
    }),
  }),
]) as z.ZodType<ManagedAgentRecord>;

const maximumManagedAgentRecordBytes = 1024 * 1024;
const maximumManagedAgentLogBytes = 32 * 1024 * 1024;
const managedAgentAppendQueues = new Map<string, Promise<void>>();

export function createInMemoryManagedAgentStore(): ManagedAgentStore {
  const records: ManagedAgentRecord[] = [];
  return {
    async append(record) {
      const validated = validateManagedAgentRecord(record, records);
      const storedBytes = records.reduce(
        (total, entry) => total + Buffer.byteLength(JSON.stringify(entry), "utf8") + 1,
        0,
      );
      if (storedBytes + validated.byteLength > maximumManagedAgentLogBytes) {
        throw new ManagedAgentStoreError("managed_agent_log_too_large");
      }
      records.push(validated.record);
    },
    async read() {
      return [...records];
    },
  };
}

export async function createJsonlManagedAgentStore(options: {
  readonly workspaceRoot: string;
  readonly stateRoot?: string;
}): Promise<ManagedAgentStore> {
  const canonicalWorkspaceRoot = await realpath(options.workspaceRoot);
  const projectKey = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex");
  const stateRoot = options.stateRoot ?? defaultManagedAgentStateRoot();
  const directories = [
    join(stateRoot, "projects"),
    join(stateRoot, "projects", projectKey),
    join(stateRoot, "projects", projectKey, "managed-agents"),
  ];
  for (const directory of directories) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  const logPath = join(directories.at(-1) as string, "events-v1.jsonl");
  await ensureManagedAgentLogFile(logPath);
  await readManagedAgentLog(logPath);
  return {
    append(record) {
      return enqueueManagedAgentAppend(logPath, async () => {
        const records = await readManagedAgentLog(logPath);
        const validated = validateManagedAgentRecord(record, records);
        const storedBytes = records.reduce(
          (total, entry) => total + Buffer.byteLength(JSON.stringify(entry), "utf8") + 1,
          0,
        );
        if (storedBytes + validated.byteLength > maximumManagedAgentLogBytes) {
          throw new ManagedAgentStoreError("managed_agent_log_too_large");
        }
        const file = await open(
          logPath,
          constants.O_APPEND | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          0o600,
        );
        try {
          const stats = await file.stat();
          if (!stats.isFile()) {
            throw new ManagedAgentStoreError("managed_agent_log_invalid");
          }
          await file.chmod(0o600);
          await file.writeFile(`${validated.serialized}\n`, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
      });
    },
    async read() {
      await (managedAgentAppendQueues.get(logPath) ?? Promise.resolve());
      return readManagedAgentLog(logPath);
    },
  };
}

export async function recoverInterruptedManagedAgents(
  store: ManagedAgentStore,
  childSessionStores?: SessionStoreDirectory<SessionRecord>,
): Promise<void> {
  let records = await store.read();
  const terminalAttempts = new Set(
    records.flatMap((record) =>
      record.type === "managed_agent_terminal" ? [record.attemptId] : [],
    ),
  );
  for (const admission of records) {
    if (admission.type !== "managed_agent_admitted" || terminalAttempts.has(admission.attemptId)) {
      continue;
    }
    const childStore = await childSessionStores?.open(admission.childSessionId);
    const childRecords = await childStore?.read();
    const childSettlement = childRecords
      ?.flatMap((record) =>
        record.schemaVersion === 1 || record.schemaVersion === 2
          ? [record.event]
          : record.record.type === "runtime_event"
            ? [record.record.event]
            : [],
      )
      .findLast((event) => event.type === "session_settled");
    if (
      childSettlement?.type === "session_settled" &&
      childSettlement.result.status === "completed" &&
      Buffer.byteLength(childSettlement.result.answer, "utf8") <= maximumManagedAgentResultBytes
    ) {
      const terminal: ManagedAgentRecord = {
        schemaVersion: 1,
        type: "managed_agent_terminal",
        sequence: records.length + 1,
        agentId: admission.agentId,
        attemptId: admission.attemptId,
        childSessionId: admission.childSessionId,
        status: "completed",
        result: { text: childSettlement.result.answer },
        transcriptDigest: digest(JSON.stringify(childRecords)),
        throughSequence: childRecords?.at(-1)?.sequence ?? 0,
        usage: usageFromChildRecords(childRecords ?? []),
        cost: { status: "unavailable" },
      };
      await store.append(terminal);
      records = [...records, terminal];
      terminalAttempts.add(admission.attemptId);
      continue;
    }
    const terminal: ManagedAgentRecord = {
      schemaVersion: 1,
      type: "managed_agent_terminal",
      sequence: records.length + 1,
      agentId: admission.agentId,
      attemptId: admission.attemptId,
      childSessionId: admission.childSessionId,
      status: "recovery_required",
      error: {
        code: "managed_agent_recovery_required",
        message:
          "The child process ended without a causally proven terminal result. Adam did not replay the interrupted model request.",
      },
    };
    await store.append(terminal);
    records = [...records, terminal];
    terminalAttempts.add(admission.attemptId);
  }
}

async function ensureManagedAgentLogFile(path: string): Promise<void> {
  const file = await open(
    path,
    constants.O_APPEND |
      constants.O_CREAT |
      constants.O_RDWR |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600,
  );
  try {
    const stats = await file.stat();
    if (!stats.isFile()) {
      throw new ManagedAgentStoreError("managed_agent_log_invalid");
    }
    await file.chmod(0o600);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function readManagedAgentLog(path: string): Promise<readonly ManagedAgentRecord[]> {
  const contents = await readFile(path, "utf8");
  if (contents.length === 0) {
    return [];
  }
  if (!contents.endsWith("\n")) {
    throw new ManagedAgentStoreError("managed_agent_log_invalid");
  }
  const records: ManagedAgentRecord[] = [];
  for (const line of contents.slice(0, -1).split("\n")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new ManagedAgentStoreError("managed_agent_log_invalid");
    }
    records.push(validateManagedAgentRecord(parsed, records).record);
  }
  return records;
}

function validateManagedAgentRecord(
  input: unknown,
  history: readonly ManagedAgentRecord[],
): {
  readonly byteLength: number;
  readonly record: ManagedAgentRecord;
  readonly serialized: string;
} {
  const parsed = managedAgentRecordSchema.safeParse(input);
  if (!parsed.success || parsed.data.sequence !== history.length + 1) {
    throw new ManagedAgentStoreError("managed_agent_log_invalid");
  }
  const candidate = parsed.data;
  if (candidate.type === "managed_agent_admitted") {
    if (
      history.some(
        (record) =>
          record.agentId === candidate.agentId ||
          record.attemptId === candidate.attemptId ||
          record.childSessionId === candidate.childSessionId,
      )
    ) {
      throw new ManagedAgentStoreError("managed_agent_log_invalid");
    }
  } else {
    const admission = history.find(
      (record) =>
        record.type === "managed_agent_admitted" && record.attemptId === candidate.attemptId,
    );
    if (
      admission === undefined ||
      admission.agentId !== candidate.agentId ||
      admission.childSessionId !== candidate.childSessionId ||
      history.some(
        (record) =>
          record.type === "managed_agent_terminal" && record.attemptId === candidate.attemptId,
      )
    ) {
      throw new ManagedAgentStoreError("managed_agent_log_invalid");
    }
  }
  const serialized = JSON.stringify(candidate);
  const byteLength = Buffer.byteLength(serialized, "utf8") + 1;
  if (byteLength > maximumManagedAgentRecordBytes) {
    throw new ManagedAgentStoreError("managed_agent_log_too_large");
  }
  return { byteLength, record: candidate, serialized };
}

function enqueueManagedAgentAppend(path: string, operation: () => Promise<void>): Promise<void> {
  const previous = managedAgentAppendQueues.get(path) ?? Promise.resolve();
  const queued = previous.then(operation, operation);
  const settled = queued.then(
    () => undefined,
    () => undefined,
  );
  managedAgentAppendQueues.set(path, settled);
  void settled.then(() => {
    if (managedAgentAppendQueues.get(path) === settled) {
      managedAgentAppendQueues.delete(path);
    }
  });
  return queued;
}

function defaultManagedAgentStateRoot(): string {
  const { XDG_STATE_HOME: xdgStateHome } = process.env;
  return xdgStateHome === undefined || xdgStateHome.length === 0
    ? join(homedir(), ".local", "state", "adam-agent")
    : join(xdgStateHome, "adam-agent");
}

export type AgentManager = {
  readonly parentRootId: string;
  readonly targetIdentity: ModelTargetIdentity;
  readonly thinkingPolicy?: ThinkingPolicySnapshotV1;
  spawnForeground(input: {
    readonly callId: string;
    readonly parentSessionId: string;
    readonly signal: AbortSignal;
    readonly task: string;
  }): Promise<ToolResult>;
};

export type ManagedAgentDeadlineScheduler = {
  schedule(delayMilliseconds: number, onDeadline: () => void): { cancel(): void };
};

const nodeManagedAgentDeadlineScheduler: ManagedAgentDeadlineScheduler = {
  schedule(delayMilliseconds, onDeadline) {
    const timer = setTimeout(onDeadline, delayMilliseconds);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

export function createAgentManager(options: {
  readonly childContextProfile: ContextProfile;
  readonly childModel: ModelDriver;
  readonly artifactStore?: ArtifactStore;
  readonly childSessionStores: SessionStoreDirectory<SessionRecord>;
  readonly managedStore: ManagedAgentStore;
  readonly parentPermissions: PermissionPolicy;
  readonly deadlineScheduler?: ManagedAgentDeadlineScheduler;
  readonly parentRoot: ProjectExecutionRootClaim;
  readonly projectId: `sha256:${string}`;
  readonly repository?: PromptContextRecord["repository"];
  readonly targetIdentity: ModelTargetIdentity;
  readonly thinkingPolicy?: ThinkingPolicySnapshotV1;
  readonly workspaceRoot: string;
}): AgentManager {
  let appendQueue = Promise.resolve();
  const appendManagedRecord = async (input: ManagedAgentRecordInput): Promise<void> => {
    const operation = appendQueue.then(async () => {
      const records = await options.managedStore.read();
      await options.managedStore.append({
        ...input,
        schemaVersion: 1,
        sequence: records.length + 1,
      });
    });
    appendQueue = operation.catch(() => undefined);
    await operation;
  };
  return {
    parentRootId: options.parentRoot.rootId,
    targetIdentity: options.targetIdentity,
    ...(options.thinkingPolicy === undefined ? {} : { thinkingPolicy: options.thinkingPolicy }),
    async spawnForeground(input) {
      const existingAdmissions = (await options.managedStore.read()).filter(
        (record) =>
          record.type === "managed_agent_admitted" &&
          record.parentSessionId === input.parentSessionId,
      );
      if (new Set(existingAdmissions.map((record) => record.agentId)).size >= 8) {
        return toolFailure(
          "managed_agent_capacity_exceeded",
          "This parent session already owns the maximum eight managed child identities.",
        );
      }
      const agentId = randomUUID();
      const attemptId = randomUUID();
      const childSessionId = randomUUID();
      const taskDigest = digest(input.task);
      const childClaim = await options.parentRoot.claimChild({ childId: agentId });
      const childController = new AbortController();
      let deadlineExpired = false;
      const abortFromCaller = () => childController.abort(input.signal.reason);
      if (input.signal.aborted) {
        abortFromCaller();
      } else {
        input.signal.addEventListener("abort", abortFromCaller, { once: true });
      }
      const deadline = (options.deadlineScheduler ?? nodeManagedAgentDeadlineScheduler).schedule(
        scoutManagedAgentProfileV1.limits.maximumDeadlineMilliseconds,
        () => {
          deadlineExpired = true;
          childController.abort(new Error("Managed Agent deadline exceeded."));
        },
      );
      try {
        await appendManagedRecord({
          type: "managed_agent_admitted",
          agentId,
          attemptId,
          childSessionId,
          parentSessionId: input.parentSessionId,
          parentToolCallId: input.callId,
          parentRootId: options.parentRoot.rootId,
          projectId: options.projectId,
          profile: "scout.v1",
          taskDigest,
          targetIdentity: options.targetIdentity,
          ...(options.thinkingPolicy === undefined
            ? {}
            : { thinkingPolicy: options.thinkingPolicy }),
          ...(options.repository === undefined
            ? {}
            : {
                repository: {
                  revision: options.repository.revision,
                  effectiveDigest: options.repository.effectiveDigest,
                },
              }),
        });
        const childStore = await options.childSessionStores.create(childSessionId);
        const childTools = createReadToolRegistry({ workspaceRoot: options.workspaceRoot });
        const childPromptContext = createPromptContextV1(childTools, options.repository);
        await childStore.append({
          schemaVersion: 3,
          sequence: 1,
          record: {
            type: "session_genesis",
            recordVersion: 2,
            sessionId: childSessionId,
            projectId: options.projectId,
            targetIdentity: options.targetIdentity,
            contextProfile: options.childContextProfile,
            promptContext: childPromptContext,
          },
        });
        const initialMessages: ModelMessage[] = [
          {
            role: "developer",
            content:
              "Managed child profile scout.v1. Work only on the exact delegated task. Use repository reads only. Do not write, execute, use Web or MCP, select Skills, access extensions, spawn, coordinate with peers, or change model and permission authority.",
          },
        ];
        const childPermissions: PermissionPolicy = {
          decide(permission) {
            if (permission.effect !== "read") {
              return "deny";
            }
            return options.parentPermissions.decide(permission) === "allow" ? "allow" : "deny";
          },
        };
        const childDependencies = {
          contextProfile: options.childContextProfile,
          model: options.childModel,
          permissions: childPermissions,
          store: childStore as SessionStore,
          tools: childTools,
          [sessionDurableContext]: {
            initialMessages,
            nextSequence: 2,
            projectId: options.projectId,
            promptContext: childPromptContext,
            repositoryWorkspaceRoot: options.workspaceRoot,
            authorizeProjectContextLoad: async () => true,
            sessionId: childSessionId,
            targetIdentity: options.targetIdentity,
            ...(options.thinkingPolicy === undefined
              ? {}
              : { thinkingPolicy: options.thinkingPolicy }),
          },
          ...(options.thinkingPolicy === undefined
            ? {}
            : { [sessionInitialThinkingPolicy]: options.thinkingPolicy }),
        };
        const child = new AgentSession(childDependencies);
        const result = await child.run(
          {
            text: `${input.task}\n\nThis child reads the live workspace. Parent changes may alter what it observes; isolated transcript does not mean repository snapshot or sandbox.`,
          },
          {
            signal: childController.signal,
            limits: {
              maxTurns: scoutManagedAgentProfileV1.limits.maximumTurnsPerAttempt,
              maxTokens: scoutManagedAgentProfileV1.limits.maximumCumulativeTokens,
            },
          },
        );
        const childRecords = await childStore.read();
        const transcriptDigest = digest(JSON.stringify(childRecords));
        const throughSequence = childRecords.at(-1)?.sequence ?? 0;
        const usage = usageFromChildRecords(childRecords);
        if (result.status === "cancelled") {
          if (deadlineExpired) {
            await appendManagedRecord({
              type: "managed_agent_terminal",
              agentId,
              attemptId,
              childSessionId,
              status: "failed",
              error: {
                code: "managed_agent_deadline_exceeded",
                message: "The foreground scout exceeded its aggregate deadline.",
              },
              transcriptDigest,
              throughSequence,
            });
            return toolFailure(
              "managed_agent_deadline_exceeded",
              "The foreground scout deadline expired.",
            );
          }
          await appendManagedRecord({
            type: "managed_agent_terminal",
            agentId,
            attemptId,
            childSessionId,
            status: "cancelled",
            reason: "caller",
            transcriptDigest,
            throughSequence,
          });
          return toolFailure("managed_agent_cancelled", "The foreground scout was cancelled.");
        }
        if (result.status !== "completed") {
          const error =
            result.status === "failed"
              ? { code: result.error.code, message: result.error.message }
              : {
                  code: "model_output_truncated",
                  message: "The foreground scout reached its output limit.",
                };
          await appendManagedRecord({
            type: "managed_agent_terminal",
            agentId,
            attemptId,
            childSessionId,
            status: "failed",
            error,
            transcriptDigest,
            throughSequence,
          });
          return toolFailure("managed_agent_failed", "The foreground scout did not complete.");
        }
        const resultBytes = Buffer.from(result.answer, "utf8");
        const createTerminalOutput = (
          terminalResult:
            | { readonly text: string }
            | {
                readonly artifact: Pick<ArtifactReference, "id" | "mediaType" | "byteCount">;
              },
        ) => ({
          agentId,
          attemptId,
          profile: "scout.v1" as const,
          status: "completed" as const,
          result: terminalResult,
          targetIdentity: options.targetIdentity,
          ...(options.thinkingPolicy === undefined
            ? {}
            : { thinkingPolicy: options.thinkingPolicy }),
          transcript: {
            sessionId: childSessionId,
            digest: transcriptDigest,
            throughSequence,
          },
          usage,
          cost: { status: "unavailable" as const },
        });
        const inlineResult = { text: result.answer } as const;
        const terminalResult =
          Buffer.byteLength(JSON.stringify(createTerminalOutput(inlineResult)), "utf8") <=
          maximumManagedAgentResultBytes
            ? inlineResult
            : options.artifactStore === undefined
              ? undefined
              : {
                  artifact: await options.artifactStore
                    .write({
                      bytes: resultBytes,
                      mediaType: "text/plain; charset=utf-8",
                      source: {
                        type: "managed_agent_result",
                        schemaVersion: 1,
                        agentId,
                        attemptId,
                        childSessionId,
                        totalBytes: resultBytes.byteLength,
                      },
                    })
                    .then(({ id, mediaType, byteCount }) => ({ id, mediaType, byteCount })),
                };
        if (terminalResult === undefined) {
          await appendManagedRecord({
            type: "managed_agent_terminal",
            agentId,
            attemptId,
            childSessionId,
            status: "failed",
            error: {
              code: "managed_agent_result_too_large",
              message: "The foreground scout result exceeds its inline bound.",
            },
            transcriptDigest,
            throughSequence,
          });
          return toolFailure(
            "managed_agent_result_too_large",
            "The foreground scout result exceeds its bound.",
          );
        }
        await appendManagedRecord({
          type: "managed_agent_terminal",
          agentId,
          attemptId,
          childSessionId,
          status: "completed",
          result: terminalResult,
          transcriptDigest,
          throughSequence,
          usage,
          cost: { status: "unavailable" },
        });
        return {
          status: "completed",
          output: createTerminalOutput(terminalResult),
        };
      } catch {
        return toolFailure(
          "managed_agent_unavailable",
          "The foreground scout could not be started safely.",
        );
      } finally {
        deadline.cancel();
        input.signal.removeEventListener("abort", abortFromCaller);
        await childClaim.release();
      }
    },
  };
}

export function createManagedAgentToolRegistry(options: {
  readonly manager: AgentManager;
}): ToolRegistry {
  const adapter = createInternalToolAdapter(
    {
      definition: {
        name: "spawn_agent",
        description:
          "Run one foreground read-only scout with fresh bounded context. It cannot run in background, select Skills, write, execute, spawn, inherit extensions, or change its model or permissions.",
        inputSchema: z.toJSONSchema(managedAgentTaskSchema),
      },
      outputSchema: managedAgentTerminalOutputSchema as z.ZodType<JsonValue>,
      effect: "delegate",
      cancellation: "abort_signal",
      maximumResult: { maximumBytes: maximumManagedAgentResultBytes },
      prepare(argumentsJson) {
        const parsed = managedAgentTaskSchema.safeParse(parseJson(argumentsJson));
        if (!parsed.success) {
          return toolFailure("invalid_tool_input", "Tool input is invalid.");
        }
        return {
          status: "ready",
          permissionSubject: {
            type: "managed_agent_spawn",
            parentRootId: options.manager.parentRootId,
            profile: "scout.v1",
            targetIdentity: options.manager.targetIdentity,
            taskDigest: digest(parsed.data.task),
            ...(options.manager.thinkingPolicy === undefined
              ? {}
              : { thinkingPolicy: options.manager.thinkingPolicy }),
          },
          execute(context) {
            return options.manager.spawnForeground({
              callId: context.callId,
              parentSessionId: context.sessionId,
              signal: context.signal,
              task: parsed.data.task,
            });
          },
        };
      },
    },
    "never",
  );
  return createInternalToolRegistry([adapter]);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function usageFromChildRecords(records: readonly SessionRecord[]): {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
} {
  return records.reduce(
    (total, record) => {
      const response =
        record.schemaVersion === 3 && record.record.type === "model_response_completed"
          ? record.record.response
          : undefined;
      return response?.usage === undefined
        ? total
        : {
            inputTokens: total.inputTokens + response.usage.inputTokens,
            outputTokens: total.outputTokens + response.usage.outputTokens,
            reasoningTokens: total.reasoningTokens + (response.usage.reasoningTokens ?? 0),
          };
    },
    { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  );
}

function toolFailure(
  code:
    | "invalid_tool_input"
    | "managed_agent_cancelled"
    | "managed_agent_capacity_exceeded"
    | "managed_agent_deadline_exceeded"
    | "managed_agent_failed"
    | "managed_agent_result_too_large"
    | "managed_agent_unavailable",
  message: string,
): Extract<ToolResult, { readonly status: "failed" }> {
  return { status: "failed", error: { code, message } };
}
