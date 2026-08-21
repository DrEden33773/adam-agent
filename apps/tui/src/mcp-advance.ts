import type { McpDisplay, PresentationCommand } from "@adam-agent/presentation";

export function mcpAdvanceCommand(sessionId: string, mcp: McpDisplay): PresentationCommand | null {
  if (mcp.status === "workspace_confirmation_required") {
    return {
      type: "confirm_mcp_workspace",
      sessionId,
      sourceDigest: mcp.source.digest,
    };
  }
  if (mcp.status === "server_approval_required") {
    const server = mcp.servers.find((candidate) => candidate.status === "approval_required");
    return server === undefined
      ? null
      : {
          type: "approve_mcp_server",
          sessionId,
          serverId: server.serverId,
          definitionDigest: server.definitionDigest,
        };
  }
  if (mcp.status === "activation_required" || mcp.status === "profile_reactivation_required") {
    const servers = mcp.servers
      .filter((server) => server.status === "approved")
      .map((server) => ({
        serverId: server.serverId,
        definitionDigest: server.definitionDigest,
      }));
    return servers.length === 0 ? null : { type: "activate_mcp_servers", sessionId, servers };
  }
  if (mcp.status === "activation_failed" && mcp.activation !== null) {
    return {
      type: "retry_mcp_activation",
      sessionId,
      generationId: mcp.activation.generationId,
    };
  }
  if (mcp.status === "catalog_stale" && mcp.activation !== null) {
    return {
      type: "revalidate_mcp_catalog",
      sessionId,
      generationId: mcp.activation.generationId,
    };
  }
  return null;
}
