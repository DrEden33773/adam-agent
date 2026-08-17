/** Tests only. This internal fault-injection surface has no compatibility promise. */

export { AiSdkModelDriver as AiSdkModelDriverForTesting } from "./ai-sdk-model-driver.js";
export type { ContextProfile } from "./context-profile.js";
export { digestContextRecordPrefix } from "./durable-context.js";
export { preparedDirectDeepSeekV2ContextProfile } from "./model-targets.js";
export type { PatchFileSystem } from "./patch-transaction.js";
export {
  sessionDurableContext,
  sessionDurableOutputLimits,
} from "./session-durable-context.js";
export {
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
  type SessionToolIntent,
  type SessionV3Record,
} from "./session-store.js";
export { createCodingToolRegistryForTesting } from "./tool-runtime.js";
