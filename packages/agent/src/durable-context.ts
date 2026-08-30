import { createHash } from "node:crypto";

import { z } from "zod";
import type { ModelDriver, ModelMessage, ModelUserContentPart } from "./agent-session-contracts.js";
import { modelMessagesWithApprovedPlanProjectionV1 } from "./approved-plan-projection.js";
import {
  type ContextProfile,
  resolveCompactionSummaryMaximumOutputTokens,
} from "./context-profile.js";
import { ModelDriverError } from "./model-driver-error.js";
import type {
  ProjectedContentUsageV1,
  ProjectedExplicitUserImageArtifactUsageV1,
} from "./model-user-content.js";
import type { ApprovedPlanProjectionV1 } from "./plan-mode.js";
import type { SessionRecord } from "./session-store.js";
import type { PermissionSubject } from "./tool-runtime.js";

export type ContextSummaryV1 = {
  readonly schemaVersion: 1;
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly progress: readonly string[];
  readonly unresolvedQuestions: readonly string[];
  readonly failures: readonly string[];
  readonly remainingVerification: readonly string[];
  readonly nextSafeAction: string;
};

export type ContextCallUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheMissInputTokens?: number;
};

export class ContextCompactionError extends Error {
  readonly code:
    | "context_compaction_input_unrecoverable"
    | "context_compaction_invalid"
    | "context_compaction_failed"
    | "context_window_unrecoverable";
  readonly usage: ContextCallUsage | undefined;

  constructor(
    code:
      | "context_compaction_input_unrecoverable"
      | "context_compaction_invalid"
      | "context_compaction_failed"
      | "context_window_unrecoverable",
    message: string,
    usage?: ContextCallUsage,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ContextCompactionError";
    this.code = code;
    this.usage = usage;
  }
}

export class ContextCompactionInterruptedError extends Error {
  readonly usage: ContextCallUsage | undefined;

  constructor(usage?: ContextCallUsage, cause?: unknown) {
    super("The context compaction request was interrupted.", { cause });
    this.name = "ContextCompactionInterruptedError";
    this.usage = usage;
  }
}

export class ContextCompactionRequestError extends Error {
  readonly usage: ContextCallUsage | undefined;

  constructor(usage: ContextCallUsage | undefined, cause: ModelDriverError) {
    super("The context compaction model request failed.", { cause });
    this.name = "ContextCompactionRequestError";
    this.usage = usage;
  }
}

export type ContextEvidenceV1 = {
  readonly schemaVersion: 1;
  readonly modifiedFiles: readonly {
    readonly sessionId?: string | undefined;
    readonly path: string;
    readonly callId: string;
    readonly sequence: number;
  }[];
  readonly permissions: readonly {
    readonly sessionId?: string | undefined;
    readonly callId: string;
    readonly name: string;
    readonly decision: "allow" | "deny";
    readonly effect?: string | undefined;
    readonly subject?: PermissionSubject | undefined;
    readonly sequence: number;
  }[];
  readonly toolResults: readonly {
    readonly sessionId?: string | undefined;
    readonly callId: string;
    readonly name: string;
    readonly status: "completed" | "failed";
    readonly sequence: number;
    readonly artifactIds: readonly string[];
  }[];
  readonly failures: readonly {
    readonly sessionId?: string | undefined;
    readonly callId: string;
    readonly name: string;
    readonly code: string;
    readonly sequence: number;
  }[];
};

const contextSummarySchema: z.ZodType<ContextSummaryV1> = z.strictObject({
  schemaVersion: z.literal(1),
  objective: z
    .string()
    .min(1)
    .max(64 * 1024),
  constraints: z
    .array(
      z
        .string()
        .min(1)
        .max(16 * 1024),
    )
    .max(128),
  progress: z
    .array(
      z
        .string()
        .min(1)
        .max(16 * 1024),
    )
    .max(128),
  unresolvedQuestions: z
    .array(
      z
        .string()
        .min(1)
        .max(16 * 1024),
    )
    .max(128),
  failures: z
    .array(
      z
        .string()
        .min(1)
        .max(16 * 1024),
    )
    .max(128),
  remainingVerification: z
    .array(
      z
        .string()
        .min(1)
        .max(16 * 1024),
    )
    .max(128),
  nextSafeAction: z
    .string()
    .min(1)
    .max(64 * 1024),
});

export function estimateActiveContextTokens(
  messages: readonly ModelMessage[],
  profile: ContextProfile,
): number {
  if (profile.estimatorVersion !== 1) {
    throw new TypeError("Unsupported context estimator version.");
  }
  return Math.ceil(Buffer.byteLength(JSON.stringify(messages), "utf8") / 4);
}

export function shouldCompactContext(
  messages: readonly ModelMessage[],
  profile: ContextProfile,
): boolean {
  return estimateActiveContextTokens(messages, profile) >= profile.compactAtTokens;
}

export function splitContextForCompaction(
  messages: readonly ModelMessage[],
  retainedTargetTokens: number,
): {
  readonly summaryMessages: readonly ModelMessage[];
  readonly retainedMessages: readonly ModelMessage[];
} {
  let retainedStart = messages.length;
  let retainedTokens = 0;
  while (retainedStart > 0) {
    let groupStart = retainedStart - 1;
    if (messages[groupStart]?.role === "tool") {
      while (groupStart > 0 && messages[groupStart - 1]?.role === "tool") {
        groupStart -= 1;
      }
      const assistant = messages[groupStart - 1];
      if (assistant?.role === "assistant" && assistant.toolCalls.length > 0) {
        groupStart -= 1;
      }
    }
    const group = messages.slice(groupStart, retainedStart);
    const groupTokens = estimateMessagesWithoutProfile(group);
    if (retainedTokens + groupTokens > retainedTargetTokens) {
      break;
    }
    retainedTokens += groupTokens;
    retainedStart = groupStart;
  }
  if (retainedStart === 0 && messages.length > 0) {
    retainedStart = messages.length;
  }
  return {
    summaryMessages: messages.slice(0, retainedStart),
    retainedMessages: messages.slice(retainedStart),
  };
}

export function shrinkContextMessagesForRetry(
  messages: readonly ModelMessage[],
): readonly ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "tool" || message.result.status !== "completed") {
      return message;
    }
    const encoded = JSON.stringify(message.result);
    if (Buffer.byteLength(encoded, "utf8") <= maximumRetryToolResultBytes) {
      return message;
    }
    return {
      ...message,
      result: {
        status: "completed" as const,
        output: boundedToolResult(encoded, maximumRetryToolResultBytes),
      },
    };
  });
}

export function digestContextMessages(messages: readonly ModelMessage[]): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(messages)).digest("hex")}`;
}

export function digestContextRecordPrefix(records: readonly SessionRecord[]): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`)
    .digest("hex")}`;
}

export async function generateContextSummary(input: {
  readonly approvedPlan?: ApprovedPlanProjectionV1;
  readonly evidence: ContextEvidenceV1;
  readonly messages: readonly ModelMessage[];
  readonly model: ModelDriver;
  readonly profile: ContextProfile;
  readonly preparedRequest?: PreparedContextSummaryRequestV1;
  readonly signal: AbortSignal;
}): Promise<{
  readonly summary: ContextSummaryV1;
  readonly replacementMessages: readonly ModelMessage[];
  readonly usage?: ContextCallUsage;
}> {
  let text = "";
  let finishReason:
    | "stop"
    | "tool_calls"
    | "length"
    | "content_filter"
    | "resource_exhausted"
    | "unknown"
    | undefined;
  let usage: ContextCallUsage | undefined;
  let usageInvalid = false;
  let invalid = false;
  const requestMessages =
    input.preparedRequest?.messages ?? createContextSummaryRequestMessages(input);
  const maximumOutputTokens = resolveCompactionSummaryMaximumOutputTokens(input.profile);
  if (
    estimatePreparedContextSummaryRequestTokens(
      requestMessages,
      input.profile,
      input.approvedPlan,
    ) +
      maximumOutputTokens >
    input.profile.contextWindowTokens
  ) {
    throw new ContextCompactionError(
      "context_compaction_input_unrecoverable",
      "The protected context cannot fit in one compaction request.",
    );
  }
  try {
    for await (const event of input.model.stream({
      messages: requestMessages,
      tools: [],
      ...(input.approvedPlan === undefined ? {} : { approvedPlan: input.approvedPlan }),
      maximumOutputTokens,
      purpose: "compaction",
      signal: input.signal,
    })) {
      if (event.type === "text_delta") {
        if (
          Buffer.byteLength(text, "utf8") + Buffer.byteLength(event.text, "utf8") >
          Math.min(maximumSummaryBytes, maximumOutputTokens * 8)
        ) {
          throw new ContextCompactionError(
            "context_compaction_invalid",
            "The context compaction response did not match the required schema.",
            usage,
          );
        }
        text += event.text;
      } else if (event.type === "usage") {
        if (!isValidContextUsage(event)) {
          invalid = true;
          usageInvalid = true;
          usage = undefined;
        } else if (!usageInvalid) {
          usage = {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            ...(event.reasoningTokens === undefined
              ? {}
              : { reasoningTokens: event.reasoningTokens }),
            ...(event.cachedInputTokens === undefined
              ? {}
              : { cachedInputTokens: event.cachedInputTokens }),
            ...(event.cacheMissInputTokens === undefined
              ? {}
              : { cacheMissInputTokens: event.cacheMissInputTokens }),
          };
        }
      } else if (event.type === "finish") {
        finishReason = event.reason;
      } else if (
        event.type !== "reasoning_start" &&
        event.type !== "reasoning_delta" &&
        event.type !== "reasoning_end"
      ) {
        invalid = true;
      }
    }
  } catch (error) {
    if (input.signal.aborted) {
      throw new ContextCompactionInterruptedError(usage, error);
    }
    if (error instanceof ModelDriverError) {
      throw new ContextCompactionRequestError(usage, error);
    }
    throw error;
  }
  if (input.signal.aborted) {
    throw new ContextCompactionInterruptedError(usage, input.signal.reason);
  }
  if (invalid || finishReason !== "stop") {
    throw new ContextCompactionError(
      "context_compaction_invalid",
      "The context compaction response did not match the required schema.",
      usage,
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new ContextCompactionError(
      "context_compaction_invalid",
      "The context compaction response did not match the required schema.",
      usage,
    );
  }
  const parsedSummary = contextSummarySchema.safeParse(decoded);
  if (!parsedSummary.success) {
    throw new ContextCompactionError(
      "context_compaction_invalid",
      "The context compaction response did not match the required schema.",
      usage,
    );
  }
  const summary = parsedSummary.data;
  const replacementMessages: readonly ModelMessage[] = [
    createContextProjectionMessage(summary, input.evidence),
  ];
  return { summary, replacementMessages, ...(usage === undefined ? {} : { usage }) };
}

export function estimateContextSummaryRequestTokens(input: {
  readonly approvedPlan?: ApprovedPlanProjectionV1;
  readonly evidence: ContextEvidenceV1;
  readonly messages: readonly ModelMessage[];
  readonly profile: ContextProfile;
}): number {
  return estimatePreparedContextSummaryRequestTokens(
    createContextSummaryRequestMessages(input),
    input.profile,
    input.approvedPlan,
  );
}

export type PreparedContextSummaryRequestV1 = {
  readonly messages: readonly ModelMessage[];
  readonly projectedContent?: ProjectedContentUsageV1;
};

export function prepareContextSummaryRequestV1(input: {
  readonly approvedPlan?: ApprovedPlanProjectionV1;
  readonly evidence: ContextEvidenceV1;
  readonly messages: readonly ModelMessage[];
  readonly profile: ContextProfile;
  readonly imageUsageByArtifactId?: ReadonlyMap<
    `sha256:${string}`,
    ProjectedExplicitUserImageArtifactUsageV1
  >;
}): PreparedContextSummaryRequestV1 {
  const messages = createContextSummaryRequestMessages(input);
  const projectedContent = projectedContentUsageFromSummaryRequest(
    messages,
    input.imageUsageByArtifactId,
  );
  return {
    messages,
    ...(projectedContent === undefined ? {} : { projectedContent }),
  };
}

function createContextSummaryRequestMessages(input: {
  readonly approvedPlan?: ApprovedPlanProjectionV1;
  readonly evidence: ContextEvidenceV1;
  readonly messages: readonly ModelMessage[];
  readonly profile: ContextProfile;
}): readonly ModelMessage[] {
  let sourceMessages = [...input.messages];
  while (true) {
    const request = buildContextSummaryRequestMessages(
      input.evidence,
      fitContextMessages(sourceMessages, maximumFittedToolResultBytes),
    );
    if (
      estimatePreparedContextSummaryRequestTokens(request, input.profile, input.approvedPlan) +
        resolveCompactionSummaryMaximumOutputTokens(input.profile) <=
      input.profile.contextWindowTokens
    ) {
      return request;
    }
    const groups = contextMessageGroups(sourceMessages);
    const firstUserIndex = groups.findIndex((group) =>
      sourceMessages.slice(group.start, group.end).some((message) => message.role === "user"),
    );
    const removable = groups.findIndex(
      (_group, index) => index !== 0 && index !== firstUserIndex && index !== groups.length - 1,
    );
    if (removable < 0) {
      return request;
    }
    const group = groups[removable] as { readonly start: number; readonly end: number };
    sourceMessages = [...sourceMessages.slice(0, group.start), ...sourceMessages.slice(group.end)];
  }
}

function buildContextSummaryRequestMessages(
  evidence: ContextEvidenceV1,
  messages: readonly unknown[],
): readonly ModelMessage[] {
  const imageParts: Array<Extract<ModelUserContentPart, { readonly type: "file" }>> = [];
  const imageToolCallIdsByAssistantIndex = new Map<number, Set<string>>();
  const imageToolMessageIndexes = new Set<number>();
  const projectedMessages = messages.map((message, messageIndex) => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("role" in message) ||
      (message.role !== "user" && message.role !== "tool") ||
      !("content" in message) ||
      !Array.isArray(message.content)
    ) {
      return message;
    }
    const toolMessage = message.role === "tool" ? message : undefined;
    if (
      toolMessage !== undefined &&
      "callId" in toolMessage &&
      typeof toolMessage.callId === "string" &&
      "name" in toolMessage &&
      typeof toolMessage.name === "string" &&
      "result" in toolMessage
    ) {
      const hasImageContent = message.content.some(isProjectableImagePart);
      if (!hasImageContent) {
        return message;
      }
      const assistantIndex = messages.findLastIndex(
        (candidate, index) =>
          index < messageIndex &&
          typeof candidate === "object" &&
          candidate !== null &&
          "role" in candidate &&
          candidate.role === "assistant" &&
          "toolCalls" in candidate &&
          Array.isArray(candidate.toolCalls) &&
          candidate.toolCalls.some(
            (call) =>
              typeof call === "object" &&
              call !== null &&
              "id" in call &&
              call.id === toolMessage.callId,
          ),
      );
      if (assistantIndex < 0) {
        throw new TypeError("Prepared compaction image tool call is unavailable.");
      }
      const imageToolCallIds = imageToolCallIdsByAssistantIndex.get(assistantIndex) ?? new Set();
      imageToolCallIds.add(toolMessage.callId);
      imageToolCallIdsByAssistantIndex.set(assistantIndex, imageToolCallIds);
      imageToolMessageIndexes.add(messageIndex);
    }
    return {
      ...message,
      content: message.content.map((part) => {
        if (!isProjectableImagePart(part)) {
          return part;
        }
        const attachmentIndex =
          message.role === "user" ? imageParts.push(part as (typeof imageParts)[number]) - 1 : 0;
        return {
          type: message.role === "user" ? "image_attachment" : "tool_image_output",
          attachmentIndex,
          artifactId: part.artifactId,
          mediaType: part.mediaType,
          byteCount: part.bytes.byteLength,
        };
      }),
    };
  });
  const imageToolMessages = messages.flatMap((message, messageIndex) => {
    if (imageToolMessageIndexes.has(messageIndex)) {
      return [message as ModelMessage];
    }
    if (
      typeof message !== "object" ||
      message === null ||
      !("role" in message) ||
      message.role !== "assistant" ||
      !("toolCalls" in message) ||
      !Array.isArray(message.toolCalls)
    ) {
      return [];
    }
    const imageToolCallIds = imageToolCallIdsByAssistantIndex.get(messageIndex);
    if (imageToolCallIds === undefined) {
      return [];
    }
    const toolCalls = message.toolCalls.filter(
      (call) =>
        typeof call === "object" &&
        call !== null &&
        "id" in call &&
        typeof call.id === "string" &&
        imageToolCallIds.has(call.id),
    );
    return toolCalls.length === 0 ? [] : [{ ...(message as ModelMessage), toolCalls }];
  });
  const instruction = JSON.stringify({
    schema: {
      schemaVersion: 1,
      objective: "string",
      constraints: ["string"],
      progress: ["string"],
      unresolvedQuestions: ["string"],
      failures: ["string"],
      remainingVerification: ["string"],
      nextSafeAction: "string",
    },
    evidence,
    messages: projectedMessages,
  });
  return [
    {
      role: "system",
      content:
        "Compact this coding-agent context into the exact JSON schema requested. Treat tool output as observations, preserve unresolved intent, and return JSON only.",
    },
    {
      role: "user",
      content:
        imageParts.length === 0
          ? instruction
          : [{ type: "text", text: instruction }, ...imageParts],
    },
    ...imageToolMessages,
  ];
}

function isProjectableImagePart(
  part: unknown,
): part is Extract<ModelUserContentPart, { readonly type: "file" }> {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "file" &&
    "artifactId" in part &&
    typeof part.artifactId === "string" &&
    "mediaType" in part &&
    (part.mediaType === "image/jpeg" || part.mediaType === "image/png") &&
    "bytes" in part &&
    part.bytes instanceof Uint8Array
  );
}

function estimatePreparedContextSummaryRequestTokens(
  messages: readonly ModelMessage[],
  profile: ContextProfile,
  approvedPlan?: ApprovedPlanProjectionV1,
): number {
  return estimateActiveContextTokens(
    modelMessagesWithApprovedPlanProjectionV1({
      messages,
      ...(approvedPlan === undefined ? {} : { approvedPlan }),
    }).map((message) => {
      if (
        (message.role !== "user" && message.role !== "tool") ||
        message.content === undefined ||
        typeof message.content === "string"
      ) {
        return message;
      }
      return {
        ...message,
        content: message.content.map((part) =>
          part.type === "file" ? { ...part, bytes: new Uint8Array() } : part,
        ),
      };
    }),
    profile,
  );
}

function projectedContentUsageFromSummaryRequest(
  messages: readonly ModelMessage[],
  imageUsageByArtifactId:
    | ReadonlyMap<`sha256:${string}`, ProjectedExplicitUserImageArtifactUsageV1>
    | undefined,
): ProjectedContentUsageV1 | undefined {
  const userUsages: ProjectedExplicitUserImageArtifactUsageV1[] = [];
  const toolUsages: ProjectedExplicitUserImageArtifactUsageV1[] = [];
  for (const message of messages) {
    if (
      (message.role !== "user" && message.role !== "tool") ||
      message.content === undefined ||
      typeof message.content === "string"
    ) {
      continue;
    }
    for (const part of message.content) {
      if (part.type !== "file") {
        continue;
      }
      const usage = imageUsageByArtifactId?.get(part.artifactId);
      if (usage === undefined) {
        throw new TypeError("Prepared compaction image usage is unavailable.");
      }
      (message.role === "tool" ? toolUsages : userUsages).push(usage);
    }
  }
  if (userUsages.length === 0 && toolUsages.length === 0) {
    return undefined;
  }
  return {
    version: 1,
    ...(userUsages.length === 0 ? {} : { explicitUserImages: summarizeImageUsages(userUsages) }),
    ...(toolUsages.length === 0 ? {} : { imageToolResults: summarizeImageUsages(toolUsages) }),
  };
}

function summarizeImageUsages(
  usages: readonly ProjectedExplicitUserImageArtifactUsageV1[],
): NonNullable<ProjectedContentUsageV1["explicitUserImages"]> {
  return {
    count: usages.length,
    byteCount: usages.reduce((total, usage) => total + usage.byteCount, 0),
    pixelCount: usages.reduce((total, usage) => total + usage.pixelCount, 0),
    maximumWidth: Math.max(...usages.map((usage) => usage.width)),
    maximumHeight: Math.max(...usages.map((usage) => usage.height)),
  };
}

function contextMessageGroups(
  messages: readonly ModelMessage[],
): readonly { readonly start: number; readonly end: number }[] {
  const groups: Array<{ readonly start: number; readonly end: number }> = [];
  let index = 0;
  while (index < messages.length) {
    const start = index;
    index += 1;
    if (messages[start]?.role === "assistant") {
      while (messages[index]?.role === "tool") {
        index += 1;
      }
    }
    groups.push({ start, end: index });
  }
  return groups;
}

export function createContextProjectionMessage(
  summary: ContextSummaryV1,
  evidence: ContextEvidenceV1,
): ModelMessage {
  return {
    role: "developer",
    content: `<context-summary schema-version="1">\n${JSON.stringify(summary)}\n</context-summary>\n<context-evidence schema-version="1">\n${JSON.stringify(evidence)}\n</context-evidence>`,
  };
}

export function reduceContextEvidence(
  records: readonly SessionRecord[],
  runId: string,
  throughSequence: number,
  sessionId?: string,
): ContextEvidenceV1 {
  const modifiedFiles: Array<ContextEvidenceV1["modifiedFiles"][number]> = [];
  const permissions: Array<ContextEvidenceV1["permissions"][number]> = [];
  const toolResults: Array<ContextEvidenceV1["toolResults"][number]> = [];
  const failures: Array<ContextEvidenceV1["failures"][number]> = [];
  for (const entry of records) {
    if (
      entry.sequence > throughSequence ||
      entry.schemaVersion !== 3 ||
      entry.record.type !== "runtime_event" ||
      entry.record.runId !== runId
    ) {
      continue;
    }
    const { event } = entry.record;
    if (event.type === "tool_permission_decided") {
      permissions.push({
        ...(sessionId === undefined ? {} : { sessionId }),
        callId: event.callId,
        name: event.name,
        decision: event.decision,
        ...(event.effect === undefined ? {} : { effect: event.effect }),
        ...(event.subject === undefined ? {} : { subject: event.subject }),
        sequence: entry.sequence,
      });
      if (event.decision === "allow" && event.effect === "write" && event.subject !== undefined) {
        for (const path of permissionSubjectPaths(event.subject)) {
          modifiedFiles.push({
            ...(sessionId === undefined ? {} : { sessionId }),
            path,
            callId: event.callId,
            sequence: entry.sequence,
          });
        }
      }
      continue;
    }
    if (event.type === "tool_completed" || event.type === "tool_failed") {
      const artifactIds = collectArtifactIds(
        event.type === "tool_completed" ? event.output : event.error,
      );
      toolResults.push({
        ...(sessionId === undefined ? {} : { sessionId }),
        callId: event.callId,
        name: event.name,
        status: event.type === "tool_completed" ? "completed" : "failed",
        sequence: entry.sequence,
        artifactIds,
      });
      if (event.type === "tool_failed") {
        failures.push({
          ...(sessionId === undefined ? {} : { sessionId }),
          callId: event.callId,
          name: event.name,
          code: event.error.code,
          sequence: entry.sequence,
        });
      }
    }
  }
  return {
    schemaVersion: 1,
    modifiedFiles,
    permissions,
    toolResults,
    failures,
  };
}

export function mergeContextEvidence(
  ...evidence: readonly (ContextEvidenceV1 | undefined)[]
): ContextEvidenceV1 {
  return {
    schemaVersion: 1,
    modifiedFiles: evidence.flatMap((entry) => entry?.modifiedFiles ?? []),
    permissions: evidence.flatMap((entry) => entry?.permissions ?? []),
    toolResults: evidence.flatMap((entry) => entry?.toolResults ?? []),
    failures: evidence.flatMap((entry) => entry?.failures ?? []),
  };
}

function fitContextMessages(
  messages: readonly ModelMessage[],
  maximumToolResultBytes: number,
): readonly unknown[] {
  return messages.map((message) => {
    if (message.role !== "tool") {
      return message;
    }
    const encoded = JSON.stringify(message.result);
    if (Buffer.byteLength(encoded, "utf8") <= maximumToolResultBytes) {
      return message;
    }
    return {
      role: message.role,
      callId: message.callId,
      name: message.name,
      result: boundedToolResult(encoded, maximumToolResultBytes),
    };
  });
}

function boundedToolResult(
  encoded: string,
  previewBytes: number,
): {
  readonly truncated: true;
  readonly byteCount: number;
  readonly digest: `sha256:${string}`;
  readonly preview: string;
} {
  return {
    truncated: true,
    byteCount: Buffer.byteLength(encoded, "utf8"),
    digest: `sha256:${createHash("sha256").update(encoded).digest("hex")}`,
    preview: encoded.slice(0, previewBytes),
  };
}

function permissionSubjectPaths(subject: PermissionSubject): readonly string[] {
  if (subject.type === "file" || subject.type === "workspace_path") {
    return [subject.path];
  }
  if (subject.type === "patch") {
    return subject.operations.flatMap((operation) =>
      operation.kind === "move" ? [operation.from, operation.to] : [operation.path],
    );
  }
  return [];
}

function collectArtifactIds(value: unknown): readonly string[] {
  const ids = new Set<string>();
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const item of entry) {
        visit(item);
      }
      return;
    }
    if (entry === null || typeof entry !== "object") {
      return;
    }
    for (const [key, item] of Object.entries(entry)) {
      if (key === "id" && typeof item === "string" && /^sha256:[0-9a-f]{64}$/u.test(item)) {
        ids.add(item);
      }
      visit(item);
    }
  };
  visit(value);
  return [...ids];
}

const maximumFittedToolResultBytes = 2 * 1024;
const maximumRetryToolResultBytes = 0;
const maximumSummaryBytes = 256 * 1024;

function estimateMessagesWithoutProfile(messages: readonly ModelMessage[]): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(messages), "utf8") / 4);
}

function isValidContextUsage(usage: {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens?: number | undefined;
  readonly cachedInputTokens?: number | undefined;
  readonly cacheMissInputTokens?: number | undefined;
}): boolean {
  const values = [
    usage.inputTokens,
    usage.outputTokens,
    usage.reasoningTokens,
    usage.cachedInputTokens,
    usage.cacheMissInputTokens,
  ];
  return (
    values.every((value) => value === undefined || (Number.isSafeInteger(value) && value >= 0)) &&
    Number.isSafeInteger(usage.inputTokens + usage.outputTokens)
  );
}
