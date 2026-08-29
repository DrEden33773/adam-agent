/** Tests only. This internal fault-injection surface has no compatibility promise. */

export { AiSdkModelDriver as AiSdkModelDriverForTesting } from "./ai-sdk-model-driver.js";
export {
  createObservedBiomeExecutionAdapter,
  type ObservedBiomeProcess,
} from "./biome-execution.js";
export type { ContextProfile } from "./context-profile.js";
export { DirectDeepSeekResponsesModelDriver as DirectDeepSeekResponsesModelDriverForTesting } from "./deepseek-responses-model-driver.js";
export { digestContextRecordPrefix } from "./durable-context.js";
export { createInputResourceUserMessageV1 } from "./input-resources.js";
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
  createInMemorySessionStoreDirectory,
  createJsonlSessionStoreDirectory,
  openJsonlSessionStore,
  type SessionContextCompactionCommittedRecord,
  type SessionContextCompactionFailedRecord,
  type SessionContextCompactionInterruptedRecord,
  type SessionContextCompactionStartedRecord,
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
