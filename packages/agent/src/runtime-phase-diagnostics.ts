/** Optional, process-local monotonic observations. Never persisted as session truth.
 * Argument reception timestamps are emitted as a bounded summary at SDK end (or
 * failure/cancellation). Sort by atMilliseconds, not callback delivery order.
 */
export type RuntimePhaseDiagnostic =
  | {
      readonly stage:
        | "first_argument"
        | "last_argument"
        | "sdk_end"
        | "provider_finish"
        | "response_durable"
        | "tool_requested";
      readonly atMilliseconds: number;
      readonly sessionId: string | null;
      readonly runId: string | null;
      readonly callId: string;
      readonly toolName: string;
      readonly byteCount: number;
      readonly fragmentCount: number;
      /** Largest interval between consecutive argument deltas. */
      readonly maxGapMilliseconds: number;
    }
  | {
      readonly stage: "delegation_admitted" | "first_child_dispatch";
      readonly atMilliseconds: number;
      readonly sessionId: string;
      readonly runId: string | null;
      readonly callId: string | null;
      readonly threadId: string;
      readonly turnId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
    };
