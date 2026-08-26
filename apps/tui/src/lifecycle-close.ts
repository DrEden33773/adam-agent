import type { McpCloseResult } from "@adam-agent/agent";

export class McpShutdownUnconfirmedError extends Error {}

export function findMcpShutdownUnconfirmedError(
  error: unknown,
): McpShutdownUnconfirmedError | undefined {
  const pending = [error];
  const visited = new Set<unknown>();
  while (pending.length > 0) {
    const candidate = pending.shift();
    if (candidate instanceof McpShutdownUnconfirmedError) {
      return candidate;
    }
    if (candidate instanceof AggregateError && !visited.has(candidate)) {
      visited.add(candidate);
      pending.push(...candidate.errors);
    }
  }
  return undefined;
}

export function requireConfirmedLifecycleClose(result: McpCloseResult): void {
  if (result.status === "mcp_shutdown_unconfirmed") {
    throw new McpShutdownUnconfirmedError("MCP shutdown could not be confirmed.");
  }
}
