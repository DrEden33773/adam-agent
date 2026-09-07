import { z } from "zod";
import type {
  ExtensionContractCodec,
  ExtensionContractReference,
  ExtensionOperationEvidenceReference,
} from "./index.js";
import {
  EXTENSION_OPERATION_JSON_MAX_CONTAINERS,
  EXTENSION_OPERATION_JSON_MAX_DEPTH,
} from "./index.js";

export const EXTENSION_MANAGED_REVIEW_CAPABILITY_ID = "adam.managed-review@1";
export const EXTENSION_MANAGED_REVIEW_MAX_EVIDENCE_COUNT = 8;
export const EXTENSION_MANAGED_REVIEW_MAX_EVIDENCE_BYTES = 12 * 1024 * 1024;
export const EXTENSION_MANAGED_REVIEW_MAX_INSTRUCTION_BYTES = 16 * 1024;
export const EXTENSION_MANAGED_REVIEW_MAX_OUTPUT_BYTES = 1024 * 1024;
export const EXTENSION_MANAGED_REVIEW_TOTAL_DEFAULT_MS = 1_800_000;
export const EXTENSION_MANAGED_REVIEW_TOTAL_MAX_MS = 1_800_000;

const digest = z
  .templateLiteral(["sha256:", z.string()])
  .refine((value) => /^sha256:[a-f0-9]{64}$/u.test(value));
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = (maximum: number) =>
  z
    .string()
    .refine(
      (value) => value.isWellFormed() && new TextEncoder().encode(value).byteLength <= maximum,
    );
const contract = z.strictObject({ id: text(256).min(1), version: count.positive() });
const provenance = z.strictObject({
  contributionId: text(256).min(1),
  extensionId: text(256).min(1),
  extensionVersion: text(128).min(1),
  operationId: z.uuid(),
  projectId: digest,
});
const artifact = z.strictObject({
  id: digest,
  byteCount: count.max(8 * 1024 * 1024),
  mediaType: text(256).min(1),
  contract,
  provenance,
});
const record = z.strictObject({
  key: text(256).min(1),
  digest,
  byteCount: count.max(6_000_000),
  contract,
  provenance,
});
const evidence = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("artifact"), artifact }),
  z.strictObject({ type: z.literal("record"), record }),
]);
const requestSchema = z.strictObject({
  evidence: z
    .array(evidence)
    .min(1)
    .max(EXTENSION_MANAGED_REVIEW_MAX_EVIDENCE_COUNT)
    .refine(
      (values) =>
        values.reduce(
          (sum, value) =>
            sum + (value.type === "artifact" ? value.artifact.byteCount : value.record.byteCount),
          0,
        ) <= EXTENSION_MANAGED_REVIEW_MAX_EVIDENCE_BYTES,
    ),
  instruction: text(EXTENSION_MANAGED_REVIEW_MAX_INSTRUCTION_BYTES).refine(
    (value) => value.trim().length > 0,
  ),
  outputContract: contract,
  limits: z.strictObject({ maximumCumulativeTokens: count.positive() }).optional(),
});
const target = z.strictObject({
  certification: z.enum(["certified", "experimental"]),
  modelId: text(256).min(1),
  profileVersion: count.positive(),
  route: z.enum(["direct", "vercel-ai-gateway"]),
  targetId: text(256).min(1),
  upstreamProviderId: text(256).min(1).optional(),
  vendor: text(256).min(1),
});
const usage = z.strictObject({
  inputTokens: count,
  outputTokens: count,
  reasoningTokens: count,
  turns: count,
});
const receipt = z.strictObject({
  reviewRunId: z.uuid(),
  policyDigest: digest,
  target,
  evidenceSetDigest: digest,
  output: z.strictObject({
    contract,
    digest,
    byteCount: count.max(EXTENSION_MANAGED_REVIEW_MAX_OUTPUT_BYTES),
  }),
  traceDigest: digest,
  usage,
});
const successSchema = z.strictObject({
  status: z.literal("completed"),
  result: z
    .json()
    .refine(
      (value) =>
        new TextEncoder().encode(JSON.stringify(value)).byteLength <=
        EXTENSION_MANAGED_REVIEW_MAX_OUTPUT_BYTES,
    ),
  receipt,
});
const failureSchema = z.strictObject({
  status: z.literal("failed"),
  reviewRunId: z.uuid().optional(),
  error: z.strictObject({
    code: z.enum([
      "invalid_request",
      "policy_denied",
      "target_unavailable",
      "capacity_expired",
      "model_failed",
      "stalled",
      "budget_exhausted",
      "output_invalid",
      "review_deadline_exceeded",
      "recovery_required",
    ]),
    message: text(512).min(1),
  }),
  partial: z
    .strictObject({
      summary: text(16 * 1024),
      traceDigest: digest,
      usage,
      output: z.strictObject({ id: digest, byteCount: count.max(64 * 1024 * 1024) }).optional(),
    })
    .optional(),
});
const terminalSchema = z.discriminatedUnion("status", [successSchema, failureSchema]);
const timestamp = z.iso.datetime().refine((value) => new Date(value).toISOString() === value);
const progressSchema = z.discriminatedUnion("phase", [
  z.strictObject({
    reviewRunId: z.uuid(),
    phase: z.enum(["waiting_for_capacity", "settling", "terminal"]),
  }),
  z
    .strictObject({
      reviewRunId: z.uuid(),
      phase: z.literal("running"),
      startedAt: timestamp,
      totalDeadlineAt: timestamp,
      totalMilliseconds: count.positive().max(EXTENSION_MANAGED_REVIEW_TOTAL_MAX_MS),
    })
    .refine(
      (value) =>
        Date.parse(value.totalDeadlineAt) - Date.parse(value.startedAt) === value.totalMilliseconds,
    ),
]);

function codec<T>(id: string, schema: z.ZodType<T>): ExtensionContractCodec<T> {
  const decode = (value: unknown) => {
    try {
      assertJson(value);
      const parsed = schema.safeParse(value);
      return parsed.success
        ? { ok: true as const, value: parsed.data }
        : {
            ok: false as const,
            issues: parsed.error.issues.map((issue) => ({
              code: issue.code,
              path: `/${issue.path.join("/")}`,
            })),
          };
    } catch {
      return { ok: false as const, issues: [{ code: "invalid_json", path: "/" }] };
    }
  };
  return Object.freeze({ id, version: 1, decode, encode: decode });
}

function assertJson(value: unknown): void {
  let containers = 0;
  const visit = (value: unknown, depth: number): void => {
    if (depth > EXTENSION_OPERATION_JSON_MAX_DEPTH) throw new TypeError("JSON depth exceeded.");
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return;
    if (typeof value === "string" && value.isWellFormed()) return;
    if (typeof value !== "object" || value === null) throw new TypeError("Invalid JSON value.");
    containers += 1;
    if (containers > EXTENSION_OPERATION_JSON_MAX_CONTAINERS)
      throw new TypeError("JSON container bound exceeded.");
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new TypeError("Invalid JSON object.");
    for (const [key, item] of Object.entries(value)) {
      if (!key.isWellFormed()) throw new TypeError("Invalid JSON key.");
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
}
export type ExtensionManagedReviewRequest = {
  readonly evidence: readonly ExtensionOperationEvidenceReference[];
  readonly instruction: string;
  readonly outputContract: ExtensionContractReference;
  readonly limits?: { readonly maximumCumulativeTokens: number } | undefined;
};
export type ExtensionManagedReviewReceipt = z.infer<typeof receipt>;
export type ExtensionManagedReviewTerminal = z.infer<typeof terminalSchema>;
export type ExtensionManagedReviewProgress = z.infer<typeof progressSchema>;
export type ExtensionManagedReviewFailure = z.infer<typeof failureSchema>;
export const extensionManagedReviewRequestCodec = codec<ExtensionManagedReviewRequest>(
  "adam.managed-review.request",
  requestSchema,
);
export const extensionManagedReviewTerminalCodec = codec(
  "adam.managed-review.terminal",
  terminalSchema,
);
export const extensionManagedReviewProgressCodec = codec(
  "adam.managed-review.progress",
  progressSchema,
);
export interface ExtensionManagedReviewCapability {
  review(input: ExtensionManagedReviewRequest): Promise<ExtensionManagedReviewTerminal>;
}
