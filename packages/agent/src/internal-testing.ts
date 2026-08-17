/** Tests only. This internal fault-injection surface has no compatibility promise. */

export type { PatchFileSystem } from "./patch-transaction.js";
export {
  openJsonlSessionStore,
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
