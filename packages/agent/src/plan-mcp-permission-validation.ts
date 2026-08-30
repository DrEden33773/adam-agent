import type { RuntimeEvent } from "./agent-session-contracts.js";
import { digestCanonicalMcpJson } from "./mcp-canonical-identity.js";
import type { PlanEligibleToolProfileV1 } from "./plan-mode.js";

export function isExactPlanMcpPermissionEventV1(input: {
  readonly event: Extract<
    RuntimeEvent,
    { readonly type: "tool_permission_requested" | "tool_permission_decided" }
  >;
  readonly runId: string;
  readonly callId: string;
  readonly callName: string;
  readonly argumentsJson: string;
  readonly effect: "execute" | "network";
  readonly definitionDigest: string | undefined;
  readonly eligibleDefinition: PlanEligibleToolProfileV1["definitions"][number];
}): boolean {
  const subject = input.event.subject;
  const expectedArgumentsDigest = exactMcpArgumentsDigest(input.argumentsJson);
  return (
    input.eligibleDefinition.source === "mcp" &&
    input.eligibleDefinition.effect === input.effect &&
    input.eligibleDefinition.definitionDigest === input.definitionDigest &&
    input.eligibleDefinition.mcp !== undefined &&
    subject?.type === "mcp_tool" &&
    input.event.callId === input.callId &&
    input.event.name === input.callName &&
    input.event.effect === input.effect &&
    input.event.scope === "call" &&
    input.event.requestId === `${input.runId}:${input.callId}` &&
    subject.qualifiedName === input.callName &&
    subject.definitionDigest === input.definitionDigest &&
    subject.serverId === input.eligibleDefinition.mcp.serverId &&
    subject.originalName === input.eligibleDefinition.mcp.originalName &&
    subject.serverDefinitionDigest === input.eligibleDefinition.mcp.serverDefinitionDigest &&
    expectedArgumentsDigest !== undefined &&
    subject.argumentsDigest === expectedArgumentsDigest
  );
}

function exactMcpArgumentsDigest(argumentsJson: string): `sha256:${string}` | undefined {
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? digestCanonicalMcpJson(parsed)
      : undefined;
  } catch {
    return undefined;
  }
}
