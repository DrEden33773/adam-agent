import {
  EXTENSION_MANAGED_REVIEW_TOTAL_DEFAULT_MS,
  EXTENSION_MANAGED_REVIEW_TOTAL_MAX_MS,
} from "@adam-agent/extension-api";
import type { ContextProfile } from "./context-profile.js";
import { managedControlDigest } from "./fleet-ledger.js";
import type { ManagedControlFrozen } from "./managed-agent-folds.js";
import type { ModelTargetIdentity } from "./model-targets.js";

export function managedReviewPolicyDigest(input: {
  readonly maximumTokens: number;
  readonly totalMilliseconds: number;
  readonly contextProfile: ContextProfile;
  readonly targetIdentity: ModelTargetIdentity;
  readonly thinkingPolicy?: NonNullable<ManagedControlFrozen["thinkingPolicy"]>;
}) {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : value;
  return managedControlDigest(
    canonical({
      version: 1,
      tools: [],
      skills: [],
      permissionEffects: [],
      maximumInactivityMilliseconds: 300_000,
      cleanupMilliseconds: 10_000,
      maximumTokens: input.maximumTokens,
      totalMilliseconds: input.totalMilliseconds,
      contextProfile: input.contextProfile,
      targetIdentity: input.targetIdentity,
      thinkingPolicy: input.thinkingPolicy ?? null,
    }),
  );
}

export function resolveManagedReviewPolicy(policy?: {
  readonly version: 1;
  readonly totalMilliseconds: number;
}) {
  const value = policy ?? {
    version: 1,
    totalMilliseconds: EXTENSION_MANAGED_REVIEW_TOTAL_DEFAULT_MS,
  };
  if (
    value.version !== 1 ||
    !Number.isSafeInteger(value.totalMilliseconds) ||
    value.totalMilliseconds <= 0 ||
    value.totalMilliseconds > EXTENSION_MANAGED_REVIEW_TOTAL_MAX_MS
  )
    throw new TypeError("Review policy can only shorten the version-one total deadline.");
  return Object.freeze({ version: 1 as const, totalMilliseconds: value.totalMilliseconds });
}

export type ManagedReviewFailureCode =
  | "invalid_request"
  | "policy_denied"
  | "target_unavailable"
  | "capacity_expired"
  | "model_failed"
  | "stalled"
  | "budget_exhausted"
  | "output_invalid"
  | "review_deadline_exceeded"
  | "recovery_required";

const messages: Record<ManagedReviewFailureCode, string> = {
  invalid_request: "The review request or its immutable evidence is invalid.",
  policy_denied: "The review exceeds the origin's current policy.",
  target_unavailable: "The review's exact origin target is unavailable.",
  capacity_expired:
    "The review could not acquire execution capacity within its Operation allowance.",
  model_failed: "The review model failed. Retained evidence is incomplete.",
  stalled: "The review stopped making causal progress. Retained evidence is incomplete.",
  budget_exhausted: "The review exhausted its provable token budget.",
  output_invalid: "The review output does not satisfy the registered contract.",
  review_deadline_exceeded:
    "The review exceeded its total execution deadline. Retained evidence is incomplete.",
  recovery_required: "The existing review requires explicit recovery or inspection.",
};

export class ManagedReviewError extends Error {
  constructor(readonly code: ManagedReviewFailureCode) {
    super(messages[code]);
    this.name = "ManagedReviewError";
  }
}
