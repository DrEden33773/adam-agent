import type { McpDisplay } from "@adam-agent/presentation";
import { expect, test } from "vitest";

import { mcpAdvanceCommand } from "./mcp-advance.js";

test("a resumed MCP profile requires exact server reactivation", () => {
  const state: McpDisplay = {
    schemaVersion: 1,
    status: "profile_reactivation_required",
    workspaceConfirmed: true,
    source: { path: ".mcp.json", digest: `sha256:${"1".repeat(64)}` },
    servers: [
      {
        serverId: "fixture",
        status: "approved",
        transport: "stdio",
        command: { kind: "executable", path: "/usr/bin/node" },
        arguments: [],
        cwd: "/workspace",
        requestedEnvironmentNames: [],
        startupEffects: ["execute"],
        definitionDigest: `sha256:${"2".repeat(64)}`,
      },
    ],
    activation: { attempt: 1, generationId: "generation-1", status: "ready" },
    catalog: null,
    profile: null,
    diagnostics: [],
  };

  expect(mcpAdvanceCommand("session-1", state)).toEqual({
    type: "activate_mcp_servers",
    sessionId: "session-1",
    servers: [
      {
        serverId: "fixture",
        definitionDigest: `sha256:${"2".repeat(64)}`,
      },
    ],
  });
});
