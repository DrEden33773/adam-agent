import type {
  OperationDisplay,
  PlanApprovalDisplay,
  PresentationTransientState,
  ToolCallDisplay,
  TranscriptItem,
} from "@adam-agent/presentation";
import type { RunResult, RuntimeEvent } from "./agent-session-contracts.js";
import type { SessionRecord } from "./session-store.js";
import { projectSessionUserContentTextV1 } from "./structured-user-content.js";

type PresentationTranscriptHistoryRecord = {
  readonly sessionId: string;
  readonly entry: SessionRecord;
};

export function projectTranscript(
  records: readonly PresentationTranscriptHistoryRecord[],
  operations: readonly OperationDisplay[],
  toolDisplays: ReadonlyMap<string, ToolCallDisplay>,
): readonly TranscriptItem[] {
  const attemptProviders = new Map<string, string>(
    records.flatMap(({ entry, sessionId }) =>
      entry.schemaVersion === 3 && entry.record.type === "provider_attempt_started"
        ? [
            [
              `${sessionId}:${entry.record.runId}:${entry.record.turn}:${entry.record.attempt}`,
              providerDisplayName(entry.record.targetIdentity.vendor),
            ] as const,
          ]
        : [],
    ),
  );
  const reasoningStarts = new Map(
    records.flatMap(({ entry, sessionId }) =>
      entry.schemaVersion === 3 &&
      entry.record.type === "runtime_event" &&
      entry.record.event.type === "model_reasoning_started"
        ? [
            [
              `${sessionId}:${entry.record.runId}:${entry.record.event.id}`,
              entry.record.event,
            ] as const,
          ]
        : [],
    ),
  );
  const terminalBoundaries = new Map(
    records.flatMap(({ entry, sessionId }) => {
      if (entry.schemaVersion !== 3) {
        return [];
      }
      if (entry.record.type === "runtime_event" && entry.record.event.type === "session_settled") {
        return [
          [`${sessionId}:${entry.record.runId}`, { sessionId, sequence: entry.sequence }] as const,
        ];
      }
      return entry.record.type === "run_settled"
        ? [[`${sessionId}:${entry.record.runId}`, { sessionId, sequence: entry.sequence }] as const]
        : [];
    }),
  );
  const publishedResponses = new Set(
    records.flatMap(({ entry, sessionId }) =>
      entry.schemaVersion === 3 && entry.record.type === "model_response_published"
        ? [`${sessionId}:${entry.record.responseSequence}`]
        : [],
    ),
  );
  const completedInlineRuns = new Set(
    records.flatMap(({ entry, sessionId }) =>
      entry.schemaVersion === 3 &&
      entry.record.type === "runtime_event" &&
      entry.record.event.type === "model_message_completed"
        ? [`${sessionId}:${entry.record.runId}`]
        : [],
    ),
  );
  const approvals = new Map<string, PlanApprovalDisplay>();
  const cancelledRevisions = new Set<string>();
  const revisionRequests = new Set<string>();
  for (const { entry } of records) {
    if (entry.schemaVersion !== 3) {
      continue;
    }
    if (entry.record.type === "plan_approval_intent") {
      approvals.set(planSubmissionKey(entry.record), {
        sessionId: entry.record.sessionId,
        commandId: entry.record.commandId,
        kickoffRunId: entry.record.kickoffRunId,
        cycleId: entry.record.cycleId,
        revision: entry.record.revision,
        planId: entry.record.planId,
        contentDigest: entry.record.contentDigest,
        policyVersion: entry.record.policyVersion,
        toolProfileDigest: entry.record.toolProfileDigest,
      });
      continue;
    }
    if (entry.record.type === "plan_cycle_exited") {
      cancelledRevisions.add(`${entry.record.cycleId}:${entry.record.revision - 1}`);
      continue;
    }
    if (entry.record.type === "logical_run_started" && entry.record.planRevision !== undefined) {
      revisionRequests.add(planSubmissionKey(entry.record.planRevision));
    }
  }
  const items: TranscriptItem[] = [];
  const terminalNoticeRuns = new Set<string>();
  for (const { entry, sessionId } of records) {
    if (entry.schemaVersion !== 3) {
      continue;
    }
    if (entry.record.type === "logical_run_started") {
      items.push({
        type: "user_message",
        id: `${sessionId}:${entry.sequence}`,
        sequence: entry.sequence,
        sourceSessionId: sessionId,
        branchBoundary: null,
        text:
          entry.record.recordVersion === 2
            ? projectSessionUserContentTextV1({
                elements: entry.record.userContent,
                occurrences: entry.record.inputResources,
              })
            : entry.record.userMessage,
      });
      continue;
    }
    if (entry.record.type === "plan_submitted") {
      const approval = approvals.get(planSubmissionKey(entry.record)) ?? null;
      items.push({
        type: "plan_submission",
        id: `${sessionId}:${entry.sequence}:plan`,
        sequence: entry.sequence,
        sourceSessionId: sessionId,
        branchBoundary: null,
        cycleId: entry.record.cycleId,
        status:
          approval !== null
            ? "approved"
            : revisionRequests.has(planSubmissionKey(entry.record))
              ? "revision_requested"
              : cancelledRevisions.has(`${entry.record.cycleId}:${entry.record.revision}`)
                ? "cancelled"
                : "ready",
        submission: {
          planId: entry.record.planId,
          revision: entry.record.revision,
          contentDigest: entry.record.contentDigest,
          ...(entry.record.title === undefined ? {} : { title: entry.record.title }),
          artifact: entry.record.artifact,
          policyVersion: entry.record.policyVersion,
          toolProfileDigest: entry.record.toolProfileDigest,
        },
        approval,
      });
      continue;
    }
    if (entry.record.type === "runtime_event" && entry.record.event.type === "tool_requested") {
      const tool = toolDisplays.get(`${sessionId}:${entry.record.event.callId}`);
      if (tool !== undefined) {
        items.push(tool);
      }
      continue;
    }
    if (entry.record.type === "context_compaction_committed") {
      items.push({
        type: "compaction_marker",
        id: `${sessionId}:${entry.sequence}`,
        sequence: entry.sequence,
        sourceSessionId: sessionId,
        branchBoundary: null,
        windowNumber: entry.record.windowNumber,
        sourceThrough: entry.record.sourceThrough,
        retainedFrom: entry.record.retainedFrom,
      });
      continue;
    }
    if (
      entry.record.type === "runtime_event" &&
      entry.record.event.type === "model_reasoning_settled" &&
      entry.record.event.status !== "completed"
    ) {
      const start = reasoningStarts.get(
        `${sessionId}:${entry.record.runId}:${entry.record.event.id}`,
      );
      const attemptIdentity = /^(\d+):(\d+):/.exec(entry.record.event.id);
      if (start !== undefined && attemptIdentity !== null) {
        items.push({
          type: "reasoning_block",
          id: reasoningDisplayId(sessionId, entry.record.runId, entry.record.event.id),
          sequence: entry.sequence,
          sourceSessionId: sessionId,
          branchBoundary: terminalBoundaries.get(`${sessionId}:${entry.record.runId}`) ?? null,
          artifactType: start.artifactType,
          disclosure: "owner_only",
          provider:
            attemptProviders.get(
              `${sessionId}:${entry.record.runId}:${attemptIdentity[1]}:${attemptIdentity[2]}`,
            ) ?? providerDisplayName(undefined),
          status: entry.record.event.status,
          text: null,
          artifact: null,
        });
      }
      continue;
    }
    if (
      entry.record.type === "runtime_event" &&
      entry.record.event.type === "session_interrupted"
    ) {
      items.push({
        type: "session_notice",
        id: `${sessionId}:${entry.sequence}`,
        sequence: entry.sequence,
        sourceSessionId: sessionId,
        branchBoundary: terminalBoundaries.get(`${sessionId}:${entry.record.runId}`) ?? null,
        status: "interrupted",
        reason: entry.record.event.reason,
      });
      continue;
    }
    if (
      entry.record.type === "provider_attempt_interrupted" &&
      entry.record.reason === "process_restart"
    ) {
      items.push({
        type: "session_notice",
        id: `${sessionId}:${entry.sequence}`,
        sequence: entry.sequence,
        sourceSessionId: sessionId,
        branchBoundary: null,
        status: "interrupted",
        reason: "process_restart",
      });
      continue;
    }
    if (
      entry.record.type === "runtime_event" &&
      entry.record.event.type === "session_settled" &&
      (entry.record.event.result.status === "failed" ||
        entry.record.event.result.status === "incomplete") &&
      !terminalNoticeRuns.has(`${sessionId}:${entry.record.runId}`)
    ) {
      terminalNoticeRuns.add(`${sessionId}:${entry.record.runId}`);
      const result = entry.record.event.result;
      items.push(
        result.status === "failed"
          ? {
              type: "session_notice",
              id: `${sessionId}:${entry.sequence}`,
              sequence: entry.sequence,
              sourceSessionId: sessionId,
              branchBoundary: { sessionId, sequence: entry.sequence },
              status: "failed",
              code: result.error.code,
              message: safeRunFailureMessage(result.error),
            }
          : {
              type: "session_notice",
              id: `${sessionId}:${entry.sequence}`,
              sequence: entry.sequence,
              sourceSessionId: sessionId,
              branchBoundary: { sessionId, sequence: entry.sequence },
              status: "incomplete",
              reason: result.reason,
            },
      );
      continue;
    }
    if (
      entry.record.type === "run_settled" &&
      entry.record.status === "incomplete" &&
      !terminalNoticeRuns.has(`${sessionId}:${entry.record.runId}`)
    ) {
      terminalNoticeRuns.add(`${sessionId}:${entry.record.runId}`);
      items.push({
        type: "session_notice",
        id: `${sessionId}:${entry.sequence}`,
        sequence: entry.sequence,
        sourceSessionId: sessionId,
        branchBoundary: { sessionId, sequence: entry.sequence },
        status: "incomplete",
        reason: entry.record.reason,
      });
      continue;
    }
    if (entry.record.type !== "model_response_completed") {
      continue;
    }
    const artifactBacked =
      entry.record.response.recordVersion === 2 &&
      (entry.record.response.text.storage === "artifact" ||
        entry.record.response.reasoning?.storage === "artifact");
    if (
      (artifactBacked && !publishedResponses.has(`${sessionId}:${entry.sequence}`)) ||
      (!artifactBacked && !completedInlineRuns.has(`${sessionId}:${entry.record.runId}`))
    ) {
      continue;
    }
    const reasoningField = entry.record.response.reasoning;
    if (reasoningField !== undefined) {
      const reasoningText =
        typeof reasoningField === "string"
          ? reasoningField
          : reasoningField.storage === "inline"
            ? reasoningField.text
            : null;
      const reasoningArtifact =
        typeof reasoningField !== "string" && reasoningField.storage === "artifact"
          ? {
              id: reasoningField.reference.id,
              mediaType: reasoningField.reference.mediaType,
              byteCount: reasoningField.reference.byteCount,
              source: "model_response" as const,
            }
          : null;
      if (reasoningArtifact !== null || (reasoningText !== null && reasoningText.length > 0)) {
        items.push({
          type: "reasoning_block",
          id: reasoningDisplayId(
            sessionId,
            entry.record.runId,
            `${entry.record.turn}:${entry.record.attempt}:provider-reasoning-0`,
          ),
          sequence: entry.sequence,
          sourceSessionId: sessionId,
          branchBoundary: terminalBoundaries.get(`${sessionId}:${entry.record.runId}`) ?? null,
          artifactType: "provider_reasoning",
          disclosure: "owner_only",
          provider: providerDisplayName(entry.record.targetIdentity.vendor),
          status: "completed",
          text: reasoningText,
          artifact: reasoningArtifact,
        });
      }
    }
    const text =
      entry.record.response.recordVersion === 2
        ? entry.record.response.text.storage === "inline"
          ? entry.record.response.text.text
          : null
        : entry.record.response.text;
    const artifact =
      entry.record.response.recordVersion === 2 && entry.record.response.text.storage === "artifact"
        ? {
            id: entry.record.response.text.reference.id,
            mediaType: entry.record.response.text.reference.mediaType,
            byteCount: entry.record.response.text.reference.byteCount,
            source: "model_response" as const,
          }
        : null;
    if (artifact === null && (text === null || text.length === 0)) {
      continue;
    }
    items.push({
      type: "assistant_message",
      id: `${sessionId}:${entry.sequence}`,
      sequence: entry.sequence,
      sourceSessionId: sessionId,
      branchBoundary: terminalBoundaries.get(`${sessionId}:${entry.record.runId}`) ?? null,
      text,
      artifact,
    });
  }
  const recordOrder = new Map(
    records.map(
      (record, index) => [`${record.sessionId}:${record.entry.sequence}`, index] as const,
    ),
  );
  const itemOrder = new Map(items.map((item, index) => [item, index] as const));
  const operationLinks: TranscriptItem[] = operations.map((display) => ({
    type: "operation_link",
    id: `operation:${display.operationId}`,
    operationId: display.operationId,
    sequence: display.origin.sourceSequence,
    sourceSessionId: display.origin.sessionId,
    branchBoundary: {
      sessionId: display.origin.sessionId,
      sequence: display.origin.sourceSequence,
    },
  }));
  return [...items, ...operationLinks].sort((left, right) => {
    const leftRecord = recordOrder.get(`${left.sourceSessionId}:${left.sequence}`) ?? Infinity;
    const rightRecord = recordOrder.get(`${right.sourceSessionId}:${right.sequence}`) ?? Infinity;
    if (leftRecord !== rightRecord) {
      return leftRecord - rightRecord;
    }
    if (left.type === "operation_link" && right.type === "operation_link") {
      return left.operationId.localeCompare(right.operationId);
    }
    if (left.type === "operation_link") {
      return 1;
    }
    if (right.type === "operation_link") {
      return -1;
    }
    return (itemOrder.get(left) ?? 0) - (itemOrder.get(right) ?? 0);
  });
}

function planSubmissionKey(input: {
  readonly cycleId: string;
  readonly revision?: number;
  readonly fromRevision?: number;
  readonly planId: string;
  readonly contentDigest: string;
}): string {
  return `${input.cycleId}:${input.revision ?? input.fromRevision}:${input.planId}:${input.contentDigest}`;
}

export function projectActiveReasoningSnapshot(input: {
  readonly records: readonly PresentationTranscriptHistoryRecord[];
  readonly sessionId: string;
  readonly runId: string;
  readonly expectedId: string;
  readonly event: Extract<RuntimeEvent, { readonly type: "model_reasoning_updated" }>;
  readonly afterSequence: number;
  readonly provider: string;
}): NonNullable<PresentationTransientState["reasoning"]> | undefined {
  let start: Extract<RuntimeEvent, { readonly type: "model_reasoning_started" }> | undefined;
  let startSequence = 0;
  for (const { entry, sessionId } of input.records) {
    if (
      sessionId !== input.sessionId ||
      entry.schemaVersion !== 3 ||
      entry.record.type !== "runtime_event" ||
      entry.record.runId !== input.runId
    ) {
      continue;
    }
    const event = entry.record.event;
    if (
      event.type === "model_reasoning_started" &&
      reasoningDisplayId(sessionId, input.runId, event.id) === input.expectedId
    ) {
      start = event;
      startSequence = entry.sequence;
      continue;
    }
    if (
      start !== undefined &&
      entry.sequence > startSequence &&
      event.type === "model_reasoning_settled" &&
      event.id === start.id
    ) {
      return undefined;
    }
  }
  if (start === undefined || start.id !== input.event.id) {
    return undefined;
  }
  return {
    id: input.expectedId,
    afterSequence: input.afterSequence,
    artifactType: start.artifactType,
    disclosure: "owner_only",
    provider: input.provider,
    status: "active",
    text: input.event.text,
  };
}

export function reasoningDisplayId(
  sessionId: string | null,
  runId: string | null,
  runtimeReasoningId: string,
): string {
  return `${sessionId ?? "unknown-session"}:${runId ?? "unknown-run"}:${runtimeReasoningId}`;
}

export function providerDisplayName(vendor: string | undefined): string {
  return vendor === "deepseek" ? "DeepSeek" : (vendor ?? "Provider");
}

type FailedRunError = Extract<RunResult, { readonly status: "failed" }>["error"];

function safeRunFailureMessage(error: FailedRunError): string {
  const code = error.code;
  if (code === "tool_effect_indeterminate") {
    return "A tool effect requires inspection before continuing.";
  }
  if (code === "session_persistence_failed") {
    return "The session could not make its result durable.";
  }
  if (code === "model_request_failed" || code === "context_compaction_failed") {
    const summary = safeModelDriverFailureSummary(error);
    const status = error.status;
    const metadata = [
      status !== undefined && Number.isSafeInteger(status) && status >= 100 && status <= 599
        ? `HTTP ${status}`
        : undefined,
    ].filter((value): value is string => value !== undefined);
    return metadata.length === 0 ? summary : `${summary} ${metadata.join(" · ")}`;
  }
  if (code.startsWith("context_") || code.startsWith("token_")) {
    return "The run could not continue within its context limits.";
  }
  if (code === "skill_activation_failed") {
    return "The requested Skill activation failed.";
  }
  return "The model run failed.";
}

function safeModelDriverFailureSummary(
  error: Extract<
    FailedRunError,
    { readonly code: "model_request_failed" | "context_compaction_failed" }
  >,
): string {
  if (
    error.category === "protocol_incompatibility" &&
    error.diagnosticCode === "tool_schema_root_not_object"
  ) {
    return "A tool schema is incompatible with the selected provider.";
  }
  const subject =
    error.code === "context_compaction_failed" ? "Context compaction" : "The provider";
  switch (error.category) {
    case "authentication":
      return `${subject} rejected the configured credential.`;
    case "authorization":
      return `${subject} denied the request.`;
    case "billing":
      return `${subject} could not run the request because billing is unavailable.`;
    case "rate_limit":
      return `${subject} rate limit was reached.`;
    case "invalid_request":
      return `${subject} rejected the request as invalid.`;
    case "provider":
      return `${subject} could not complete the request.`;
    case "transport":
      return `${subject} connection failed.`;
    case "protocol_incompatibility":
      return `${subject} response was incompatible with Adam.`;
    case "timeout":
      return `${subject} request reached its deadline.`;
    case "aborted":
      return `${subject} request was aborted.`;
    case "unknown":
      return `${subject} request failed.`;
  }
}
