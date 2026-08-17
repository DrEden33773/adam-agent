import { valid, validRange } from "semver";
import { z } from "zod";

export const EXTENSION_API_VERSION = "0.2.0";
export const EXTENSION_BIOME_CAPABILITY_ID = "adam.analyzer-execution.biome@1";
export const EXTENSION_BIOME_MAX_FILES = 100;
export const EXTENSION_BIOME_MAX_FILE_BYTES = 1024 * 1024;
export const EXTENSION_BIOME_MAX_REPORT_BYTES = 5_000_000;
export const EXTENSION_BIOME_MAX_SNAPSHOT_BYTES = 5_000_000;
export const EXTENSION_BIOME_MAX_STDERR_BYTES = 1024 * 1024;
export const EXTENSION_BIOME_MAX_STDOUT_BYTES = 1024 * 1024;
export const EXTENSION_BIOME_PROFILE = "adam-biome-recommended-v1";
export const EXTENSION_ARTIFACT_CAPABILITY_ID = "adam.artifact.publish@1";
export const EXTENSION_ARTIFACT_MAX_AGGREGATE_BYTES = 16 * 1024 * 1024;
export const EXTENSION_ARTIFACT_MAX_COUNT = 8;
export const EXTENSION_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
export const EXTENSION_RECORDS_CAPABILITY_ID = "adam.storage.records@1";
export const EXTENSION_RECORD_MAX_BYTES = 6_000_000;
export const EXTENSION_RECORD_MAX_CREATES = 16;
export const EXTENSION_RECORD_MAX_AGGREGATE_BYTES = 8_000_000;
export const EXTENSION_RECORD_NAMESPACE_MAX_BYTES = 256_000_000;
export const EXTENSION_ID_MAX_LENGTH = 256;
export const EXTENSION_OPERATION_DEADLINE_DEFAULT_MS = 60_000;
export const EXTENSION_OPERATION_DEADLINE_MAX_MS = 300_000;
export const EXTENSION_OPERATION_INPUT_MAX_BYTES = 12_000_000;
export const EXTENSION_OPERATION_JSON_MAX_CONTAINERS = 100_000;
export const EXTENSION_OPERATION_JSON_MAX_DEPTH = 64;
export const EXTENSION_OPERATION_OUTPUT_MAX_BYTES = 5_000_000;
export const EXTENSION_OPERATION_PROGRESS_MAX_BYTES = 1024 * 1024;
export const EXTENSION_OPERATION_PROGRESS_MAX_RECORDS = 256;
export const EXTENSION_OPERATION_PROGRESS_RECORD_MAX_BYTES = 64 * 1024;
export const EXTENSION_PACKAGE_NAME_MAX_LENGTH = 256;
export const EXTENSION_PACKAGE_VERSION_MAX_LENGTH = 128;

const capabilityRequirementSchema = z.strictObject({
  id: z.string().min(1),
  version: z
    .string()
    .min(1)
    .refine((version) => validRange(version) !== null),
});

const contractReferenceSchema = z.strictObject({
  id: z.string().min(1),
  version: z.number().int().positive(),
});

const operationContributionSchema = z.strictObject({
  kind: z.literal("operation"),
  id: z.string().min(1),
  input: contractReferenceSchema,
  output: contractReferenceSchema,
  progress: contractReferenceSchema,
  recovery: z.strictObject({ version: z.literal(1) }).optional(),
});

const extensionPackageManifestSchema = z
  .object({
    name: z.string().min(1).max(EXTENSION_PACKAGE_NAME_MAX_LENGTH),
    version: z
      .string()
      .min(1)
      .max(EXTENSION_PACKAGE_VERSION_MAX_LENGTH)
      .refine((version) => valid(version) !== null),
    type: z.literal("module"),
    adamAgent: z.strictObject({
      id: z.string().min(1).max(EXTENSION_ID_MAX_LENGTH),
      apiVersion: z
        .string()
        .min(1)
        .refine((version) => validRange(version) !== null),
      runtime: z.strictObject({ entry: z.string().min(1) }),
      capabilities: z.strictObject({
        required: z.array(capabilityRequirementSchema),
        optional: z.array(capabilityRequirementSchema),
      }),
      contributions: z.array(operationContributionSchema),
    }),
  })
  .superRefine((manifest, context) => {
    const capabilityIds = [
      ...manifest.adamAgent.capabilities.required,
      ...manifest.adamAgent.capabilities.optional,
    ].map((capability) => capability.id);
    if (new Set(capabilityIds).size !== capabilityIds.length) {
      context.addIssue({
        code: "custom",
        message: "Capability declarations must have unique IDs.",
        path: ["adamAgent", "capabilities"],
      });
    }
    const contributionIds = manifest.adamAgent.contributions.map((contribution) => contribution.id);
    if (new Set(contributionIds).size !== contributionIds.length) {
      context.addIssue({
        code: "custom",
        message: "Contribution declarations must have unique IDs.",
        path: ["adamAgent", "contributions"],
      });
    }
  });

export type ExtensionCapabilityRequirement = z.infer<typeof capabilityRequirementSchema>;
export type ExtensionContractReference = z.infer<typeof contractReferenceSchema>;
export type ExtensionOperationContribution = z.infer<typeof operationContributionSchema>;
export type ExtensionPackageManifest = z.infer<typeof extensionPackageManifestSchema>;

export type ExtensionContractIssue = {
  readonly code: string;
  readonly path: string;
};

export type ExtensionContractResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ExtensionContractIssue[] };

export interface ExtensionContractCodec<T = unknown> {
  readonly id: string;
  readonly version: number;
  decode(value: unknown): ExtensionContractResult<T>;
  encode(value: T): ExtensionContractResult<unknown>;
}

export type ExtensionOperationRegistration = {
  readonly id: string;
  readonly input: ExtensionContractCodec;
  readonly output: ExtensionContractCodec;
  readonly progress: ExtensionContractCodec;
  execute(input: unknown, context: ExtensionOperationContext): Promise<unknown> | unknown;
  reconcile?(
    input: unknown,
    context: ExtensionOperationReconciliationContext,
  ): Promise<ExtensionOperationReconciliationResult> | ExtensionOperationReconciliationResult;
};

export type ExtensionOperationBudgetSnapshot = {
  readonly inputBytes: number;
  readonly outputBytesRemaining: number;
  readonly progressBytesRemaining: number;
  readonly progressRecordsRemaining: number;
};

export type ExtensionOperationProvenance = {
  readonly contributionId: string;
  readonly extensionId: string;
  readonly extensionVersion: string;
  readonly projectId: string;
};

export type ExtensionOperationScopedProvenance = ExtensionOperationProvenance & {
  readonly operationId: string;
};

export type ExtensionArtifactSummary = {
  readonly byteCount: number;
  readonly contract: ExtensionContractReference;
  readonly id: string;
  readonly mediaType: string;
  readonly provenance: ExtensionOperationScopedProvenance;
};

export interface ExtensionArtifactPublishCapability {
  publish(input: {
    readonly bytes: Uint8Array;
    readonly contract: ExtensionContractReference;
    readonly mediaType: string;
  }): Promise<ExtensionArtifactSummary>;
}

export type ExtensionRecordSummary = {
  readonly byteCount: number;
  readonly contract: ExtensionContractReference;
  readonly digest: string;
  readonly key: string;
  readonly provenance: ExtensionOperationScopedProvenance;
};

export type ExtensionRecord = ExtensionRecordSummary & {
  readonly value: ExtensionJsonValue;
};

export type ExtensionRecordList = {
  readonly nextCursor?: string;
  readonly records: readonly ExtensionRecordSummary[];
};

export interface ExtensionRecordCapability {
  create(input: {
    readonly contract: ExtensionContractReference;
    readonly key: string;
    readonly value: ExtensionJsonValue;
  }): Promise<ExtensionRecordSummary>;
  get(key: string): Promise<ExtensionRecord | undefined>;
  list(input: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly prefix: string;
  }): Promise<ExtensionRecordList>;
}

export type ExtensionBiomeFileSnapshot = {
  readonly content: string;
  readonly path: string;
};

export type ExtensionBiomeAnalysis = {
  readonly execution: {
    readonly analyzer: "biome";
    readonly analyzerVersion: string;
    readonly exitCode: number;
    readonly profile: typeof EXTENSION_BIOME_PROFILE;
    readonly provenance: ExtensionOperationScopedProvenance;
  };
  readonly report: ExtensionJsonValue;
};

export interface ExtensionBiomeCapability {
  analyze(input: {
    readonly files: readonly ExtensionBiomeFileSnapshot[];
    readonly profile: typeof EXTENSION_BIOME_PROFILE;
  }): Promise<ExtensionBiomeAnalysis>;
}

export type ExtensionOperationCapabilities = {
  readonly [EXTENSION_BIOME_CAPABILITY_ID]?: ExtensionBiomeCapability;
  readonly [EXTENSION_ARTIFACT_CAPABILITY_ID]?: ExtensionArtifactPublishCapability;
  readonly [EXTENSION_RECORDS_CAPABILITY_ID]?: ExtensionRecordCapability;
};

export type ExtensionOperationContext = {
  readonly budget: ExtensionOperationBudgetSnapshot;
  readonly capabilities: ExtensionOperationCapabilities;
  readonly deadlineAt: string;
  readonly diagnostics: readonly ExtensionActivationDiagnostic[];
  readonly operationId: string;
  readonly provenance: ExtensionOperationProvenance;
  readonly signal: AbortSignal;
  progress(value: unknown): Promise<void>;
};

export type ExtensionOperationEvidenceReference =
  | { readonly type: "artifact"; readonly artifact: ExtensionArtifactSummary }
  | { readonly type: "record"; readonly record: ExtensionRecordSummary };

export type ExtensionOperationReconciliationContext = {
  readonly deadlineAt: string;
  readonly evidence: {
    readonly artifacts: {
      read(artifact: ExtensionArtifactSummary): Promise<Uint8Array | undefined>;
    };
    readonly records: {
      get(key: string): Promise<ExtensionRecord | undefined>;
    };
  };
  readonly operationId: string;
  readonly provenance: ExtensionOperationProvenance;
  readonly signal: AbortSignal;
};

export type ExtensionOperationReconciliationResult =
  | {
      readonly artifacts?: readonly ExtensionArtifactSummary[] | undefined;
      readonly output: unknown;
      readonly status: "completed";
    }
  | {
      readonly artifacts?: readonly ExtensionArtifactSummary[] | undefined;
      readonly error: ExtensionOperationFailure;
      readonly status: "failed";
    }
  | {
      readonly evidence?: readonly ExtensionOperationEvidenceReference[] | undefined;
      readonly message: string;
      readonly status: "inspection_required";
    };

export type ExtensionIdentity = {
  readonly id: string;
  readonly packageName: string;
  readonly version: string;
};

export type ExtensionJsonValue =
  | boolean
  | number
  | string
  | null
  | readonly ExtensionJsonValue[]
  | { readonly [key: string]: ExtensionJsonValue };

export type ExtensionOperationStartedEvent = {
  readonly type: "operation_started";
  readonly contributionId: string;
  readonly deadlineAt: string;
  readonly definitionDigest: string;
  readonly extensionId: string;
  readonly extensionVersion: string;
  readonly idempotencyKey: string;
  readonly input: ExtensionJsonValue;
  readonly inputDigest: string;
  readonly projectId: string;
};

export type ExtensionOperationReconciliationStartedEvent = {
  readonly type: "operation_reconciliation_started";
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly definitionDigest: string;
};

export type ExtensionOperationProgressEvent = {
  readonly type: "operation_progress";
  readonly value: ExtensionJsonValue;
};

export type ExtensionOperationArtifactPublishedEvent = {
  readonly type: "operation_artifact_published";
  readonly artifact: ExtensionArtifactSummary;
};

export type ExtensionOperationCancellationReason = "caller" | "extension_disabled";

export type ExtensionOperationCancelRequestedEvent = {
  readonly type: "operation_cancel_requested";
  readonly reason: ExtensionOperationCancellationReason;
};

export type ExtensionOperationCompletedEvent = {
  readonly artifacts?: readonly ExtensionArtifactSummary[] | undefined;
  readonly type: "operation_completed";
  readonly output: ExtensionJsonValue;
};

export type ExtensionOperationCancelledEvent = {
  readonly artifacts?: readonly ExtensionArtifactSummary[] | undefined;
  readonly type: "operation_cancelled";
  readonly reason: ExtensionOperationCancellationReason;
};

export type ExtensionOperationFailure = {
  readonly code:
    | "extension_execution_failed"
    | "operation_capability_conflict"
    | "operation_capability_execution_failed"
    | "operation_capability_input_invalid"
    | "operation_capability_limit_exceeded"
    | "operation_capability_permission_denied"
    | "operation_capability_persistence_failed"
    | "operation_capability_output_invalid"
    | "operation_deadline_exceeded"
    | "operation_output_invalid"
    | "operation_persistence_failed"
    | "operation_progress_invalid"
    | "operation_progress_limit_exceeded";
  readonly message: string;
};

export type ExtensionOperationFailedEvent = {
  readonly artifacts?: readonly ExtensionArtifactSummary[] | undefined;
  readonly type: "operation_failed";
  readonly error: ExtensionOperationFailure;
};

export type ExtensionOperationInspectionRequiredEvent = {
  readonly type: "operation_inspection_required";
  readonly evidence?: readonly ExtensionOperationEvidenceReference[] | undefined;
  readonly message: string;
};

export type ExtensionOperationEvent =
  | ExtensionOperationArtifactPublishedEvent
  | ExtensionOperationCancelRequestedEvent
  | ExtensionOperationCancelledEvent
  | ExtensionOperationCompletedEvent
  | ExtensionOperationFailedEvent
  | ExtensionOperationInspectionRequiredEvent
  | ExtensionOperationProgressEvent
  | ExtensionOperationReconciliationStartedEvent
  | ExtensionOperationStartedEvent;

export type ExtensionActivationCapability = {
  readonly availableVersion?: string;
  readonly granted: boolean;
  readonly id: string;
  readonly requestedVersion: string;
};

export type ExtensionActivationDiagnostic =
  | {
      readonly availableVersion: string;
      readonly capabilityId: string;
      readonly code: "optional_capability_incompatible";
      readonly requestedVersion: string;
    }
  | {
      readonly capabilityId: string;
      readonly code: "optional_capability_unavailable" | "optional_capability_ungranted";
      readonly requestedVersion: string;
    };

export type ExtensionCompatibility = {
  readonly api: {
    readonly hostVersion: string;
    readonly requestedVersion: string;
  };
  readonly capabilities: {
    readonly optional: readonly ExtensionActivationCapability[];
    readonly required: readonly ExtensionActivationCapability[];
  };
};

export interface ExtensionActivationContext {
  readonly compatibility: ExtensionCompatibility;
  readonly configuration: ExtensionJsonValue;
  readonly diagnostics: readonly ExtensionActivationDiagnostic[];
  readonly extension: ExtensionIdentity;
  registerOperation(registration: ExtensionOperationRegistration): void;
}

export interface ExtensionDeactivationContext {
  readonly extension: ExtensionIdentity;
}

export function parseExtensionPackageManifest(value: unknown): ExtensionPackageManifest {
  return extensionPackageManifestSchema.parse(value);
}
