export class SessionLifecycleError extends Error {
  readonly code:
    | "session_branch_boundary_invalid"
    | "session_invalid"
    | "session_model_target_incompatible"
    | "session_model_target_unavailable"
    | "session_user_configuration_invalid"
    | "session_thinking_policy_unsupported"
    | "session_persistence_failed"
    | "session_skill_confirmation_required"
    | "session_skill_policy_rejected"
    | "session_skill_unavailable"
    | "session_not_found"
    | "session_project_mismatch"
    | "mcp_config_invalid"
    | "mcp_bootstrap_failed"
    | "mcp_catalog_invalid"
    | "mcp_catalog_too_large"
    | "mcp_initialize_failed"
    | "mcp_start_failed"
    | "mcp_startup_timeout"
    | "mcp_activation_cancelled"
    | "mcp_shutdown_unconfirmed"
    | "project_in_use"
    | "project_owner_unavailable";
  readonly supportedLevelIds?: readonly string[];

  constructor(code: SessionLifecycleError["code"], supportedLevelIds: readonly string[] = []) {
    super(
      code === "session_thinking_policy_unsupported" && supportedLevelIds.length > 0
        ? `${sessionLifecycleErrorMessage(code)} Choose ${supportedLevelIds.join(", ")}.`
        : sessionLifecycleErrorMessage(code),
    );
    this.name = "SessionLifecycleError";
    this.code = code;
    if (supportedLevelIds.length > 0) {
      this.supportedLevelIds = supportedLevelIds;
    }
  }
}

function sessionLifecycleErrorMessage(code: SessionLifecycleError["code"]): string {
  switch (code) {
    case "mcp_bootstrap_failed":
      return "The exact MCP package bootstrap failed.";
    case "mcp_config_invalid":
      return "The project MCP configuration is invalid.";
    case "mcp_catalog_invalid":
      return "The MCP tool catalog is invalid.";
    case "mcp_catalog_too_large":
      return "The MCP tool catalog exceeded its bounded limits.";
    case "mcp_initialize_failed":
      return "The MCP server initialization failed.";
    case "mcp_start_failed":
      return "The approved MCP server could not be started.";
    case "mcp_startup_timeout":
      return "The MCP server startup deadline elapsed.";
    case "mcp_activation_cancelled":
      return "The MCP activation was cancelled before it became ready.";
    case "mcp_shutdown_unconfirmed":
      return "The MCP server shutdown could not be causally confirmed.";
    case "project_in_use":
      return "Another process owns lifecycle mutations for this canonical project.";
    case "project_owner_unavailable":
      return "The OS-backed project lifecycle owner is unavailable.";
    case "session_branch_boundary_invalid":
      return "The requested branch position is not a complete session boundary.";
    case "session_invalid":
      return "The session history is invalid.";
    case "session_model_target_incompatible":
      return "The requested exact model target is not compatible with this session boundary.";
    case "session_model_target_unavailable":
      return "The requested exact model target is not ready in this runtime.";
    case "session_user_configuration_invalid":
      return "The user model configuration does not produce a supported context profile.";
    case "session_thinking_policy_unsupported":
      return "The requested thinking level is unavailable for this exact model target.";
    case "session_persistence_failed":
      return "The new session could not be persisted.";
    case "session_skill_unavailable":
      return "One selected Agent Skill is unavailable for draft admission.";
    case "session_skill_confirmation_required":
      return "One selected Agent Skill requires confirmation before draft admission.";
    case "session_skill_policy_rejected":
      return "One selected Agent Skill is denied by the draft admission policy.";
    case "session_not_found":
      return "The session does not exist in this project.";
    case "session_project_mismatch":
      return "The session belongs to another canonical project.";
  }
}
