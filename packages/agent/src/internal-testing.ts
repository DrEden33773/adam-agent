/** Tests only. This internal fault-injection surface has no compatibility promise. */

export { managedAgentPromptSummary, sessionToolProfileNames } from "./agent-session.js";
export { AiSdkModelDriver as AiSdkModelDriverForTesting } from "./ai-sdk-model-driver.js";
export {
  createObservedBiomeExecutionAdapter,
  type ObservedBiomeProcess,
} from "./biome-execution.js";
export type { ContextProfile } from "./context-profile.js";
export { DirectDeepSeekResponsesModelDriver as DirectDeepSeekResponsesModelDriverForTesting } from "./deepseek-responses-model-driver.js";
export { digestContextRecordPrefix } from "./durable-context.js";
export { createInputResourceUserMessageV1 } from "./input-resources.js";
export {
  createAgentManager,
  createManagedAgentToolRegistry,
  type ManagedAgentDeadlineScheduler,
  type ManagedAgentInactivityScheduler,
  type ManagedAgentRecord,
  type ManagedAgentStore,
  ManagedAgentStoreError,
  recoverInterruptedManagedAgents,
} from "./managed-agent.js";
export {
  researchManagedAgentProfileV1,
  researchManagedAgentProfileV2,
  scoutManagedAgentProfileV1,
  scoutManagedAgentProfileV2,
} from "./managed-agent-profiles.js";
export {
  createInMemoryManagedAgentStore,
  createJsonlManagedAgentStore,
} from "./managed-agent-store.js";
export type {
  McpBeforeToolDispatchBarrier,
  McpBootstrapScheduler,
  McpClientTransport,
  McpCloseConfirmation,
  McpDiscoveryScheduler,
  McpIdleScheduler,
  McpRequestScheduler,
  McpTransportFactory,
  McpTransportLaunch,
} from "./mcp-host.js";
export {
  mcpBeforeToolDispatchBarrier,
  mcpBootstrapScheduler,
  mcpCloseConfirmation,
  mcpDiscoveryScheduler,
  mcpIdleScheduler,
  mcpPackageManagerCliPath,
  mcpPackageRegistryUrl,
  mcpRequestScheduler,
  mcpTransportFactory,
} from "./mcp-host.js";
export { preparedDirectDeepSeekV2ContextProfile } from "./model-targets.js";
export type { PatchFileSystem } from "./patch-transaction.js";
export { assessPlanCommandV1 } from "./plan-command-assessment.js";
export {
  assessPlanCommandExecutionV1,
  resolvePlanTrustedExecutableV1,
} from "./plan-executable-policy.js";
export {
  createPlanGitAttestationV1,
  planGitAutomaticPolicyV1,
  planGitEnvironmentV1,
} from "./plan-git-policy.js";
export { isExactPlanMcpPermissionEventV1 } from "./plan-mcp-permission-validation.js";
export { createPlanToolProfileV1, submitPlanToolDefinitionV1 } from "./plan-mode.js";
export {
  createPlanShellEnvironmentV1,
  createUnavailablePlanShellEnvironmentV1,
} from "./plan-shell-environment.js";
export {
  type PresentationArtifactReadBarrier,
  type PresentationHydrationBarrier,
  type PresentationRuntimeRefreshBarrier,
  type PresentationSessionRecordReader,
  presentationArtifactReadBarrier,
  presentationCatalogPageSize,
  presentationHistoryPageSize,
  presentationHydrationBarrier,
  presentationRuntimeRefreshBarrier,
  presentationSessionRecordReader,
  resolvePresentationTerminalContext,
} from "./presentation-session.js";
export {
  createProjectExecutionDomain,
  ProjectExecutionDomainError,
} from "./project-execution-domain.js";
export type {
  ProjectLifecycleOwner,
  ProjectLifecycleOwnerLease,
} from "./project-lifecycle-owner.js";
export {
  createProjectLifecycleOwner,
  ProjectLifecycleOwnerError,
} from "./project-lifecycle-owner.js";
export {
  assemblePromptMessagesV1,
  createPromptContextV1,
  digestPromptRequestV1,
} from "./prompt-assembly.js";
export {
  createRepositorySearchToolAdapter as createRepositorySearchToolAdapterForTesting,
  type RepositorySearchBackend,
  type RepositorySearchBackendBudget,
  type RepositorySearchProcessObserver,
  repositorySearchBackendForTesting,
} from "./repository-search.js";
export { createSearxngAdapterForTesting } from "./searxng-search-provider.js";
export {
  createPresentationPreferencesWithStorageForTesting,
  createTrustedWorkspaceTrustForTesting,
  createWorkspaceTrustWithStorageForTesting,
} from "./secure-user-configuration.js";
export {
  sessionDurableContext,
  sessionDurableOutputLimits,
} from "./session-durable-context.js";
export {
  type InputResourceIngestBarrier,
  inputResourceIngestBarrier,
  type McpActivationSettlementBarrier,
  type McpCatalogStaleDurableBarrier,
  type McpCatalogStaleObservationBarrier,
  mcpActivationSettlementBarrier,
  mcpCatalogStaleDurableBarrier,
  mcpCatalogStaleObservationBarrier,
  type PlanApprovalIntentBarrier,
  type PlanShellEnvironmentFactory,
  planApprovalIntentBarrier,
  planShellEnvironmentFactory,
  type SessionCloseDrainBarrier,
  type SessionLogicalRunStartedBarrier,
  type SessionRuntimeNotificationTransform,
  type SessionTitleDeadlineScheduler,
  sessionAutomaticTitlesEnabled,
  sessionCloseDrainBarrier,
  sessionLogicalRunStartedBarrier,
  sessionProjectLifecycleOwner,
  sessionRuntimeNotificationTransform,
  sessionStoreDirectory,
  sessionTitleDeadlineScheduler,
  type WorkspaceMcpLeaseTransitionBarrier,
  workspaceMcpLeaseTransitionBarrier,
} from "./session-lifecycle.js";
export {
  createInMemorySessionStore,
  createInMemorySessionStoreDirectory,
  createJsonlSessionStoreDirectory,
  openJsonlSessionStore,
  type SessionContextCompactionCommittedRecord,
  type SessionContextCompactionFailedRecord,
  type SessionContextCompactionInterruptedRecord,
  type SessionContextCompactionStartedRecord,
  type SessionEventRecord,
  type SessionGenesisRecord,
  type SessionModelResponseCompletedRecord,
  type SessionProviderAttemptInterruptedRecord,
  type SessionProviderAttemptStartedRecord,
  type SessionRecord,
  type SessionRuntimeEventRecord,
  type SessionStore,
  type SessionStoreDirectory,
  type SessionToolIntent,
  type SessionV3Record,
} from "./session-store.js";
export { createCodingToolRegistryForTesting } from "./tool-runtime.js";
export {
  type TurnComposerStageBarrier,
  turnComposerStageBarrier,
} from "./turn-composer.js";
export { extractWebText as extractWebTextForTesting } from "./web-content-extraction.js";
export {
  createInMemoryWebEvidenceStore,
  createJsonlWebEvidenceStore,
  createWebEvidenceToolRegistry,
  type WebHttpAdapter,
} from "./web-evidence.js";
export { createWebEvidenceProduction } from "./web-evidence-production.js";
export {
  createSafeWebHttpAdapter,
  resolveWebTarget as resolveWebTargetForTesting,
  SafeWebHttpError,
  type WebDnsResolver,
} from "./web-safe-http.js";
export {
  createWebSearchConfigurationController,
  createWebSearchConfigurationWithStorageForTesting,
} from "./web-search-configuration.js";
