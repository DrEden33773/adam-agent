import type { McpCloseResult } from "@adam-agent/agent";

export class McpShutdownUnconfirmedError extends Error {}

export function requireConfirmedLifecycleClose(result: McpCloseResult): void {
  if (result.status === "mcp_shutdown_unconfirmed") {
    throw new McpShutdownUnconfirmedError("MCP shutdown could not be confirmed.");
  }
}
