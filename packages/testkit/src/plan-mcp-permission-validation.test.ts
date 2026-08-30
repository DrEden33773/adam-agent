import { createHash } from "node:crypto";

import type { RuntimeEvent } from "@adam-agent/agent";
import { isExactPlanMcpPermissionEventV1 } from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";

test("Plan MCP permission validation binds the exact call, profile, and canonical arguments", () => {
  const runId = "123e4567-e89b-42d3-a456-426614176020";
  const callId = "plan-mcp-execute";
  const callName = "mcp__fixture__echo__123456789abc";
  const definitionDigest = `sha256:${"1".repeat(64)}` as const;
  const serverDefinitionDigest = `sha256:${"2".repeat(64)}` as const;
  const argumentsJson = '{"value":"exact"}';
  const argumentsDigest =
    `sha256:${createHash("sha256").update(argumentsJson).digest("hex")}` as const;
  const eligibleDefinition = {
    name: callName,
    definitionDigest,
    effect: "execute" as const,
    source: "mcp" as const,
    mcp: {
      serverId: "fixture",
      originalName: "echo",
      serverDefinitionDigest,
    },
  };
  const subject = {
    type: "mcp_tool" as const,
    serverId: "fixture",
    originalName: "echo",
    qualifiedName: callName,
    serverDefinitionDigest,
    definitionDigest,
    argumentsDigest,
  };
  const event = {
    type: "tool_permission_requested" as const,
    requestId: `${runId}:${callId}`,
    callId,
    name: callName,
    effect: "execute" as const,
    scope: "call" as const,
    subject,
  } satisfies Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }>;
  const validate = (candidate: unknown) =>
    isExactPlanMcpPermissionEventV1({
      event: candidate as Extract<
        RuntimeEvent,
        { readonly type: "tool_permission_requested" | "tool_permission_decided" }
      >,
      runId,
      callId,
      callName,
      argumentsJson,
      effect: "execute",
      definitionDigest,
      eligibleDefinition,
    });

  expect(validate(event)).toBe(true);
  for (const candidate of [
    { ...event, requestId: `wrong:${callId}` },
    { ...event, subject: undefined },
    { ...event, subject: { type: "file" as const, path: "README.md" } },
    { ...event, subject: { ...subject, serverId: "other" } },
    { ...event, subject: { ...subject, originalName: "other" } },
    { ...event, subject: { ...subject, qualifiedName: `${callName}-other` } },
    {
      ...event,
      subject: { ...subject, serverDefinitionDigest: `sha256:${"3".repeat(64)}` as const },
    },
    { ...event, subject: { ...subject, definitionDigest: `sha256:${"4".repeat(64)}` as const } },
    { ...event, subject: { ...subject, argumentsDigest: `sha256:${"5".repeat(64)}` as const } },
  ]) {
    expect(validate(candidate), JSON.stringify(candidate)).toBe(false);
  }
});
