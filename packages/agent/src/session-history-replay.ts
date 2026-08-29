import type { ModelMessage } from "./agent-session-contracts.js";
import { createContextProjectionMessage, digestContextMessages } from "./durable-context.js";
import {
  createInputResourceProjectionMessageV1,
  createInputResourceUserMessageV1,
} from "./input-resources.js";
import { SessionLifecycleError } from "./session-lifecycle-error.js";
import type { SessionModelResponseField, SessionRecord } from "./session-store.js";

export function modelMessagesFromCompleteRecords(
  records: readonly SessionRecord[],
): ModelMessage[] {
  const currentRecords = records.filter((record) => record.schemaVersion === 3);
  if (currentRecords.length !== records.length) {
    throw new SessionLifecycleError("session_invalid");
  }
  const checkpoint = currentRecords.findLast(
    (record) => record.record.type === "context_compaction_committed",
  );
  if (checkpoint?.record.type === "context_compaction_committed") {
    const checkpointRecord = checkpoint.record;
    const retainedRecords = currentRecords.filter(
      (record) =>
        record.sequence >= checkpointRecord.retainedFrom &&
        record.sequence <= checkpointRecord.sourceThrough,
    );
    const replacement = [
      createContextProjectionMessage(checkpointRecord.summary, checkpointRecord.evidence),
      ...(checkpointRecord.inputResources === undefined ||
      checkpointRecord.inputResources.length === 0
        ? []
        : [createInputResourceProjectionMessageV1(checkpointRecord.inputResources)]),
      ...modelMessagesFromCanonicalRecords(retainedRecords),
    ];
    if (digestContextMessages(replacement) !== checkpointRecord.replacementDigest) {
      throw new SessionLifecycleError("session_invalid");
    }
    const laterRecords = currentRecords.filter(
      (record) => record.sequence > (checkpoint?.sequence ?? Number.MAX_SAFE_INTEGER),
    );
    return [...replacement, ...modelMessagesFromCanonicalRecords(laterRecords)];
  }
  return modelMessagesFromCanonicalRecords(currentRecords);
}

export function modelMessagesFromCanonicalRecords(
  currentRecords: readonly Extract<SessionRecord, { readonly schemaVersion: 3 }>[],
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const record of currentRecords) {
    if (record.record.type === "logical_run_started") {
      messages.push(
        createInputResourceUserMessageV1(record.record.userMessage, record.record.inputResources),
      );
      continue;
    }
    if (record.record.type !== "model_response_completed") {
      continue;
    }
    const responseRecord = record.record;
    const responseText = inlineModelResponseField(responseRecord.response.text);
    const responseReasoning =
      responseRecord.response.reasoning === undefined
        ? undefined
        : inlineModelResponseField(responseRecord.response.reasoning);
    messages.push({
      role: "assistant",
      content: responseText,
      ...(responseReasoning === undefined ? {} : { reasoning: responseReasoning }),
      toolCalls: responseRecord.response.toolCalls,
    });
    for (const call of responseRecord.response.toolCalls) {
      const resultRecord = currentRecords.find(
        (candidate) =>
          candidate.sequence > record.sequence &&
          candidate.record.type === "runtime_event" &&
          candidate.record.runId === responseRecord.runId &&
          (candidate.record.event.type === "tool_completed" ||
            candidate.record.event.type === "tool_failed") &&
          candidate.record.event.callId === call.id &&
          candidate.record.event.name === call.name,
      );
      if (
        resultRecord?.record.type !== "runtime_event" ||
        (resultRecord.record.event.type !== "tool_completed" &&
          resultRecord.record.event.type !== "tool_failed")
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      const result =
        resultRecord.record.event.type === "tool_completed"
          ? ({ status: "completed", output: resultRecord.record.event.output } as const)
          : ({ status: "failed", error: resultRecord.record.event.error } as const);
      messages.push({ role: "tool", callId: call.id, name: call.name, result });
    }
  }
  return messages;
}

export function inlineModelResponseField(field: string | SessionModelResponseField): string {
  if (typeof field === "string") {
    return field;
  }
  if (field.storage === "inline") {
    return field.text;
  }
  throw new SessionLifecycleError("session_invalid");
}
