import type { ModelMessage, ModelRequest } from "./agent-session-contracts.js";
import type { ApprovedPlanProjectionV1 } from "./plan-mode.js";

const approvedPlanProjectionHeader =
  "Adam runtime approved Plan projection v1 (assistant-owned context; no additional prompt authority):";

export function modelMessagesWithApprovedPlanProjectionV1(
  request: Pick<ModelRequest, "approvedPlan" | "messages">,
): readonly ModelMessage[] {
  if (request.approvedPlan === undefined) {
    return request.messages;
  }
  const insertionIndex = request.messages.findIndex(
    (message) => message.role !== "system" && message.role !== "developer",
  );
  const resolvedInsertionIndex = insertionIndex < 0 ? request.messages.length : insertionIndex;
  const projection: ModelMessage = {
    role: "assistant",
    content: serializeApprovedPlanProjectionV1(request.approvedPlan),
    toolCalls: [],
  };
  return [
    ...request.messages.slice(0, resolvedInsertionIndex),
    projection,
    ...request.messages.slice(resolvedInsertionIndex),
  ];
}

function serializeApprovedPlanProjectionV1(projection: ApprovedPlanProjectionV1): string {
  return `${approvedPlanProjectionHeader}\n${JSON.stringify({
    version: projection.version,
    sessionId: projection.sessionId,
    commandId: projection.commandId,
    kickoffRunId: projection.kickoffRunId,
    cycleId: projection.cycleId,
    revision: projection.revision,
    planId: projection.planId,
    contentDigest: projection.contentDigest,
    ...(projection.title === undefined ? {} : { title: projection.title }),
    policyVersion: projection.policyVersion,
    toolProfileDigest: projection.toolProfileDigest,
    markdown: projection.markdown,
  })}`;
}
