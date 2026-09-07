import { createHash } from "node:crypto";
import type {
  ExtensionContractCodec,
  ExtensionManagedReviewFailure,
  ExtensionManagedReviewRequest,
  ExtensionManagedReviewTerminal,
} from "@adam-agent/extension-api";
import { extensionManagedReviewTerminalCodec } from "@adam-agent/extension-api";
import type { ManagedControlOutcome } from "@adam-agent/presentation";
import type { ModelDriver } from "./agent-session-contracts.js";
import type { ArtifactStore, ExtensionArtifactSource } from "./artifact-store.js";
import type { ContextProfile } from "./context-profile.js";
import {
  type ManagedAgentControl,
  managedReviewAdmission,
  managedReviewScope,
} from "./managed-agent-control.js";
import { managedControlDigest } from "./managed-agent-folds.js";
import { ManagedReviewError, type ManagedReviewFailureCode } from "./managed-review-policy.js";
import type { ModelTargetIdentity } from "./model-targets.js";
import type { OperationOrigin } from "./operation-store.js";
import type { ThinkingPolicySnapshotV1 } from "./thinking-policy.js";

export class ManagedReviewRecoveryRequired extends ManagedReviewError {
  constructor(readonly partial?: ExtensionManagedReviewFailure["partial"]) {
    super("recovery_required");
  }
}

function reviewPartial(
  outcome: ManagedControlOutcome,
): NonNullable<ExtensionManagedReviewFailure["partial"]> {
  return {
    summary: outcome.summary,
    traceDigest: outcome.transcript.digest,
    usage: {
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      reasoningTokens: outcome.usage.reasoningTokens,
      turns: outcome.usage.providerCalls,
    },
    ...(outcome.artifact === undefined
      ? {}
      : { output: { id: outcome.artifact.id, byteCount: outcome.artifact.byteCount } }),
  };
}

export type ManagedReviewResolvedOrigin = {
  readonly status: "ready";
  readonly control: ManagedAgentControl;
  readonly model: ModelDriver;
  readonly targetIdentity: ModelTargetIdentity;
  readonly contextProfile: ContextProfile;
  readonly thinkingPolicy?: ThinkingPolicySnapshotV1;
};

export type ManagedReviewRuntime = {
  readonly policy?: { readonly version: 1; readonly totalMilliseconds: number };
  readonly deadlineScheduler?: {
    schedule(milliseconds: number, onDeadline: () => void): { cancel(): void };
  };
  resolveOrigin(input: {
    readonly origin: OperationOrigin;
    readonly projectId: `sha256:${string}`;
    readonly signal: AbortSignal;
  }): Promise<
    ManagedReviewResolvedOrigin | { readonly status: "target_unavailable" | "policy_denied" }
  >;
};

/** Translates one Operation request into the existing Control owner's no-tool reviewer lane. */
export async function runManagedReview(options: {
  readonly control: ManagedAgentControl;
  readonly origin: ManagedReviewResolvedOrigin;
  readonly projectId: `sha256:${string}`;
  readonly sourceSequence: number;
  readonly parentSessionId: string;
  readonly reviewRunId: string;
  readonly requestDigest: `sha256:${string}`;
  readonly request: ExtensionManagedReviewRequest;
  readonly outputCodec: ExtensionContractCodec;
  readonly evidence: { readonly id: `sha256:${string}`; readonly byteCount: number };
  readonly artifactStore: ArtifactStore;
  readonly outputSource: ExtensionArtifactSource;
  readonly totalMilliseconds: number;
  readonly onStarted: () => Promise<ModelDriver | false>;
  readonly onOutcome: () => Promise<void>;
  readonly signal: AbortSignal;
}): Promise<ExtensionManagedReviewTerminal> {
  const admission = await options.control[managedReviewAdmission]({
    totalMilliseconds: options.totalMilliseconds,
    signal: options.signal,
    origin: {
      parentSessionId: options.parentSessionId,
      projectId: options.projectId,
      sourceSequence: options.sourceSequence,
      targetIdentity: options.origin.targetIdentity,
      contextProfile: options.origin.contextProfile,
      ...(options.origin.thinkingPolicy === undefined
        ? {}
        : { thinkingPolicy: options.origin.thinkingPolicy }),
    },
    reviewRunId: options.reviewRunId,
    requestDigest: options.requestDigest,
    instruction: options.request.instruction,
    evidence: options.evidence,
    ...(options.request.limits === undefined
      ? {}
      : { maximumTokens: options.request.limits.maximumCumulativeTokens }),
    onStarted: options.onStarted,
    onOutcome: options.onOutcome,
  });
  if (admission.event.type !== "admitted" || admission.event.frozen?.review === undefined)
    throw new Error("Missing exact review admission.");
  const frozen = admission.event.frozen;
  const reviewPolicy = admission.event.frozen.review;
  const observer = new AbortController();
  let cancellation: ReturnType<ManagedAgentControl["dispatch"]> | undefined;
  let cancellationObserved = false;
  const cancel = () => {
    cancellation = options.control.dispatch(
      {
        type: "cancel_turn",
        parentSessionId: options.parentSessionId,
        threadId: admission.threadId,
        expectedTurnId: admission.turnId,
      },
      { [managedReviewScope]: options.reviewRunId },
    );
    void cancellation.catch(() => observer.abort());
  };
  options.signal.addEventListener("abort", cancel, { once: true });
  if (options.signal.aborted) cancel();
  try {
    for await (const frame of options.control.observe({
      [managedReviewScope]: options.reviewRunId,
      parentSessionId: options.parentSessionId,
      signal: observer.signal,
    })) {
      let snapshot = frame.snapshot;
      if (cancellation !== undefined && !cancellationObserved) {
        const receipt = await cancellation;
        snapshot = await options.control.inspect({
          parentSessionId: options.parentSessionId,
          [managedReviewScope]: options.reviewRunId,
        });
        const current = snapshot.threads.find(
          (thread) =>
            thread.threadId === admission.threadId && thread.turn.turnId === admission.turnId,
        );
        if (
          receipt.status === "rejected" &&
          (current?.turn.outcome === undefined || current.turn.recovery === "required")
        )
          throw new ManagedReviewRecoveryRequired(
            current?.turn.outcome === undefined ? undefined : reviewPartial(current.turn.outcome),
          );
        cancellationObserved = true;
      }
      const thread = snapshot.threads.find((thread) => thread.threadId === admission.threadId);
      if (
        snapshot.status !== "ready" ||
        thread === undefined ||
        thread.turn.turnId !== admission.turnId ||
        thread.turn.recovery === "required"
      )
        throw new ManagedReviewRecoveryRequired(
          thread?.turn.outcome === undefined ? undefined : reviewPartial(thread.turn.outcome),
        );
      const outcome = thread?.turn.outcome;
      if (thread?.turn.phase !== "idle" || outcome === undefined) continue;
      const failed = (code: ManagedReviewFailureCode): ExtensionManagedReviewTerminal => {
        const error = new ManagedReviewError(code);
        return {
          status: "failed",
          reviewRunId: options.reviewRunId,
          error: { code: error.code, message: error.message },
          partial: reviewPartial(outcome),
        };
      };
      if (outcome.status !== "completed" || options.signal.reason instanceof ManagedReviewError) {
        const error = options.signal.reason;
        if (error instanceof ManagedReviewError) return failed(error.code);
        switch (outcome.error?.code) {
          case "managed_agent_stalled":
            return failed("stalled");
          case "fleet_budget_exhausted":
          case "fleet_estimator_overrun":
          case "token_limit_exceeded":
          case "turn_limit_exceeded":
            return failed("budget_exhausted");
          case "model_request_failed":
          case "model_stream_incomplete":
          case "model_protocol_invalid":
          case "model_output_truncated":
          case "model_content_filtered":
            return failed("model_failed");
          case "output_limit":
          case "model_response_too_large":
            return failed("output_invalid");
          default:
            throw new Error("The review did not complete.");
        }
      }
      let output = outcome.summary;
      if (outcome.artifact !== undefined) {
        const bytes = await options.artifactStore.read(outcome.artifact.id, {
          maximumBytes: outcome.artifact.byteCount,
        });
        if (
          bytes === undefined ||
          bytes.byteLength !== outcome.artifact.byteCount ||
          `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== outcome.artifact.id
        )
          throw new Error("The review output is unavailable.");
        output = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      }
      let json: unknown;
      try {
        json = JSON.parse(output);
      } catch (error) {
        if (error instanceof SyntaxError) return failed("output_invalid");
        throw error;
      }
      const decoded = options.outputCodec.decode(json);
      if (!decoded.ok) return failed("output_invalid");
      const serialized = options.outputCodec.encode(decoded.value);
      if (!serialized.ok) return failed("output_invalid");
      const value = JSON.stringify(serialized.value);
      const terminal = extensionManagedReviewTerminalCodec.decode({
        status: "completed",
        result: decoded.value,
        receipt: {
          reviewRunId: options.reviewRunId,
          policyDigest: reviewPolicy.policyDigest,
          target: frozen.targetIdentity,
          evidenceSetDigest: managedControlDigest(options.request.evidence),
          output: {
            contract: options.request.outputContract,
            digest: `sha256:${createHash("sha256").update(value).digest("hex")}`,
            byteCount: Buffer.byteLength(value, "utf8"),
          },
          traceDigest: outcome.transcript.digest,
          usage: {
            inputTokens: outcome.usage.inputTokens,
            outputTokens: outcome.usage.outputTokens,
            reasoningTokens: outcome.usage.reasoningTokens,
            turns: outcome.usage.providerCalls,
          },
        },
      });
      if (!terminal.ok) return failed("output_invalid");
      if (terminal.value.status !== "completed")
        throw new Error("Missing successful output receipt.");
      const outputArtifact = await options.artifactStore.write({
        bytes: Buffer.from(value, "utf8"),
        mediaType: "application/json",
        source: options.outputSource,
      });
      if (
        outputArtifact.id !== terminal.value.receipt.output.digest ||
        outputArtifact.byteCount !== terminal.value.receipt.output.byteCount
      )
        throw new Error("The immutable review output receipt is invalid.");
      return terminal.value;
    }
    throw new Error("The review settlement is unavailable.");
  } finally {
    observer.abort();
    options.signal.removeEventListener("abort", cancel);
  }
}
