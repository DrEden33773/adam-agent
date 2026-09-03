import { valid, validRange } from "semver";
import { z } from "zod";

export const EXTENSION_API_VERSION = "0.5.0";
export const EXTENSION_MANAGED_SESSION_CAPABILITY_ID = "adam.managed-session@1";
export const EXTENSION_MANAGED_SESSION_V2_CAPABILITY_ID = "adam.managed-session@2";
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
export const EXTENSION_PROJECT_CHANGE_DIFF_MAX_BYTES = 1_000_000;
export const EXTENSION_PROJECT_CHANGE_ENTRY_MAX_BYTES = 1_000_000;
export const EXTENSION_PROJECT_CHANGE_MAX_ENTRIES_PER_SIDE = 100;
export const EXTENSION_PROJECT_CHANGE_PATHS_MAX_BYTES = 256 * 1024;
export const EXTENSION_PROJECT_CHANGE_PATH_MAX_BYTES = 4_096;
export const EXTENSION_PROJECT_CHANGE_SNAPSHOT_MAX_BYTES = 12_000_000;
export const EXTENSION_PROJECT_CHANGE_SOURCES_MAX_BYTES = 8_000_000;
export const EXTENSION_PROJECT_CHANGE_SNAPSHOT_CONTRACT = Object.freeze({
  id: "adam.project-change-snapshot",
  version: 1,
});

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

const commandDescriptorSchema = z.strictObject({
  id: z.string().min(1).max(EXTENSION_ID_MAX_LENGTH),
  version: z.number().int().positive(),
  name: z
    .string()
    .regex(/^[a-z]+$/u)
    .max(64),
  title: z.string().min(1).max(256),
});

const projectChangesInputSourceSchema = z.strictObject({
  id: z.literal("project_changes"),
  version: z.literal(1),
});

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const gitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const projectChangePathSchema = z
  .string()
  .refine(isStrictUnicode, { message: "invalid-unicode" })
  .refine(isProjectRelativePath, { message: "invalid-path" })
  .refine((path) => utf8ByteLength(path) <= EXTENSION_PROJECT_CHANGE_PATH_MAX_BYTES, {
    message: "max-bytes",
  });
const projectChangeSourceSchema = z.strictObject({
  content: z
    .string()
    .refine(isStrictUnicode, { message: "invalid-unicode" })
    .refine((content) => utf8ByteLength(content) <= EXTENSION_PROJECT_CHANGE_ENTRY_MAX_BYTES, {
      message: "max-bytes",
    }),
  contentDigest: digestSchema,
  mode: z.enum(["100644", "100755"]),
  path: projectChangePathSchema,
  side: z.enum(["base", "head"]),
});
const projectChangeUnavailableSchema = z.strictObject({
  mode: z.enum(["100644", "100755", "120000", "160000"]),
  path: projectChangePathSchema,
  reason: z.enum(["binary", "symlink", "gitlink"]),
  side: z.enum(["base", "head"]),
});
const projectChangeSnapshotSchema = z
  .strictObject({
    base: z.discriminatedUnion("kind", [
      z.strictObject({
        commit: gitObjectIdSchema,
        kind: z.literal("head"),
        tree: gitObjectIdSchema,
      }),
      z.strictObject({ kind: z.literal("unborn"), tree: gitObjectIdSchema }),
    ]),
    candidateTree: gitObjectIdSchema,
    capturePolicy: z.strictObject({
      id: z.literal("adam.git-project-changes"),
      objectFormat: z.enum(["sha1", "sha256"]),
      version: z.literal(1),
    }),
    digest: digestSchema,
    kind: z.literal("adam.project-change-snapshot"),
    schemaVersion: z.literal(1),
    sources: z
      .array(projectChangeSourceSchema)
      .max(EXTENSION_PROJECT_CHANGE_MAX_ENTRIES_PER_SIDE * 2),
    unavailable: z
      .array(projectChangeUnavailableSchema)
      .max(EXTENSION_PROJECT_CHANGE_MAX_ENTRIES_PER_SIDE * 2),
    unifiedDiff: z
      .string()
      .min(1)
      .refine(isStrictUnicode, { message: "invalid-unicode" })
      .refine((diff) => utf8ByteLength(diff) <= EXTENSION_PROJECT_CHANGE_DIFF_MAX_BYTES, {
        message: "max-bytes",
      }),
  })
  .superRefine((snapshot, context) => {
    const seen = new Set<string>();
    const paths = new Set<string>();
    let sourceBytes = 0;
    let pathBytes = 0;
    for (const [index, source] of snapshot.sources.entries()) {
      const identity = `${source.side}\0${source.path}`;
      if (seen.has(identity)) {
        context.addIssue({
          code: "custom",
          message: "duplicate-entry",
          path: ["sources", index],
        });
      }
      seen.add(identity);
      if (!paths.has(source.path)) {
        paths.add(source.path);
        pathBytes += utf8ByteLength(source.path);
      }
      sourceBytes += utf8ByteLength(source.content);
    }
    for (const [index, unavailable] of snapshot.unavailable.entries()) {
      const identity = `${unavailable.side}\0${unavailable.path}`;
      if (seen.has(identity)) {
        context.addIssue({
          code: "custom",
          message: "duplicate-entry",
          path: ["unavailable", index],
        });
      }
      seen.add(identity);
      if (!paths.has(unavailable.path)) {
        paths.add(unavailable.path);
        pathBytes += utf8ByteLength(unavailable.path);
      }
      if (
        (unavailable.reason === "binary" &&
          unavailable.mode.startsWith("1") &&
          unavailable.mode !== "100644" &&
          unavailable.mode !== "100755") ||
        (unavailable.reason === "symlink" && unavailable.mode !== "120000") ||
        (unavailable.reason === "gitlink" && unavailable.mode !== "160000")
      ) {
        context.addIssue({
          code: "custom",
          message: "mode-reason-mismatch",
          path: ["unavailable", index, "reason"],
        });
      }
    }
    for (const side of ["base", "head"] as const) {
      const count = [...snapshot.sources, ...snapshot.unavailable].filter(
        (entry) => entry.side === side,
      ).length;
      if (count > EXTENSION_PROJECT_CHANGE_MAX_ENTRIES_PER_SIDE) {
        context.addIssue({ code: "custom", message: "max-entries", path: [side] });
      }
    }
    if (sourceBytes > EXTENSION_PROJECT_CHANGE_SOURCES_MAX_BYTES) {
      context.addIssue({ code: "custom", message: "max-bytes", path: ["sources"] });
    }
    if (pathBytes > EXTENSION_PROJECT_CHANGE_PATHS_MAX_BYTES) {
      context.addIssue({ code: "custom", message: "max-bytes", path: ["paths"] });
    }
    if (utf8ByteLength(JSON.stringify(snapshot)) > EXTENSION_PROJECT_CHANGE_SNAPSHOT_MAX_BYTES) {
      context.addIssue({ code: "custom", message: "max-bytes", path: [] });
    }
    const oidLength = snapshot.capturePolicy.objectFormat === "sha1" ? 40 : 64;
    const objectIds = [
      snapshot.base.tree,
      ...(snapshot.base.kind === "head" ? [snapshot.base.commit] : []),
      snapshot.candidateTree,
    ];
    if (objectIds.some((objectId) => objectId.length !== oidLength)) {
      context.addIssue({
        code: "custom",
        message: "object-format-mismatch",
        path: ["capturePolicy"],
      });
    }
  });

const operationContributionSchema = z.strictObject({
  kind: z.literal("operation"),
  id: z.string().min(1),
  input: contractReferenceSchema,
  output: contractReferenceSchema,
  progress: contractReferenceSchema,
  managedOutput: contractReferenceSchema.optional(),
  command: commandDescriptorSchema.optional(),
  inputSource: projectChangesInputSourceSchema.optional(),
  report: contractReferenceSchema.optional(),
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
    const commandDescriptors = manifest.adamAgent.contributions.flatMap((contribution) =>
      contribution.command === undefined ? [] : [contribution.command],
    );
    const commandIds = commandDescriptors.map((command) => command.id);
    const commandNames = commandDescriptors.map((command) => command.name);
    if (
      new Set(commandIds).size !== commandIds.length ||
      new Set(commandNames).size !== commandNames.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Command descriptors must have unique IDs and names.",
        path: ["adamAgent", "contributions"],
      });
    }
  });

export type ExtensionCapabilityRequirement = z.infer<typeof capabilityRequirementSchema>;
export type ExtensionCommandDescriptor = z.infer<typeof commandDescriptorSchema>;
export type ExtensionContractReference = z.infer<typeof contractReferenceSchema>;
export type ExtensionOperationContribution = z.infer<typeof operationContributionSchema>;
export type ExtensionPackageManifest = z.infer<typeof extensionPackageManifestSchema>;
export type ExtensionProjectChangesInputSource = z.infer<typeof projectChangesInputSourceSchema>;
export type ExtensionProjectChangeSnapshot = {
  readonly base:
    | {
        readonly commit: string;
        readonly kind: "head";
        readonly tree: string;
      }
    | {
        readonly kind: "unborn";
        readonly tree: string;
      };
  readonly candidateTree: string;
  readonly capturePolicy: {
    readonly id: "adam.git-project-changes";
    readonly objectFormat: "sha1" | "sha256";
    readonly version: 1;
  };
  readonly digest: `sha256:${string}`;
  readonly kind: "adam.project-change-snapshot";
  readonly schemaVersion: 1;
  readonly sources: readonly {
    readonly content: string;
    readonly contentDigest: `sha256:${string}`;
    readonly mode: "100644" | "100755";
    readonly path: string;
    readonly side: "base" | "head";
  }[];
  readonly unavailable: readonly {
    readonly mode: "100644" | "100755" | "120000" | "160000";
    readonly path: string;
    readonly reason: "binary" | "symlink" | "gitlink";
    readonly side: "base" | "head";
  }[];
  readonly unifiedDiff: string;
};

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

export const extensionProjectChangeSnapshotCodec: ExtensionContractCodec<ExtensionProjectChangeSnapshot> =
  Object.freeze({
    id: EXTENSION_PROJECT_CHANGE_SNAPSHOT_CONTRACT.id,
    version: EXTENSION_PROJECT_CHANGE_SNAPSHOT_CONTRACT.version,
    decode: decodeProjectChangeSnapshot,
    encode: decodeProjectChangeSnapshot,
  });

export type ExtensionOperationRegistration = {
  readonly id: string;
  readonly input: ExtensionContractCodec;
  readonly output: ExtensionContractCodec;
  readonly progress: ExtensionContractCodec;
  readonly managedOutput?: ExtensionContractCodec;
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

export interface ExtensionManagedSessionCapability {
  run(input: ExtensionManagedSessionRequest): Promise<ExtensionManagedSessionTerminal>;
}

export interface ExtensionManagedSessionV2Capability {
  run(input: ExtensionManagedSessionV2Request): Promise<ExtensionManagedSessionV2Terminal>;
}

export type ExtensionManagedSessionRequest = {
  readonly evidence: readonly ExtensionOperationEvidenceReference[];
  readonly limits: {
    readonly deadlineMilliseconds: number;
    readonly maximumCumulativeTokens: number;
    readonly maximumTurns: number;
  };
  readonly managedRole: string;
  readonly output: ExtensionContractReference;
  readonly profile: { readonly id: "reviewer.v1"; readonly version: 1 };
  readonly selectedSkills: readonly [];
  readonly task: string;
};

export type ExtensionManagedSessionTerminal = {
  readonly agentId: string;
  readonly attemptId: string;
  readonly cost: { readonly status: "unavailable" };
  readonly profile: {
    readonly digest: `sha256:${string}`;
    readonly id: "reviewer.v1";
    readonly selectedSkillsDigest: `sha256:${string}`;
    readonly version: 1;
  };
  readonly result: unknown;
  readonly status: "completed";
  readonly target: {
    readonly certification: "certified" | "experimental";
    readonly modelId: string;
    readonly profileVersion: number;
    readonly route: "direct" | "vercel-ai-gateway";
    readonly targetId: string;
    readonly upstreamProviderId?: string;
    readonly vendor: string;
  };
  readonly transcript: {
    readonly digest: `sha256:${string}`;
    readonly sessionId: string;
    readonly throughSequence: number;
  };
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly reasoningTokens: number;
    readonly turns: number;
  };
};

export type ExtensionManagedSessionV2Request = {
  readonly evidence: readonly ExtensionOperationEvidenceReference[];
  readonly limits?: {
    readonly maximumCumulativeTokens: number;
  };
  readonly managedRole: string;
  readonly output: ExtensionContractReference;
  readonly profile: { readonly id: "reviewer.v1"; readonly version: 1 };
  readonly selectedSkills: readonly [];
  readonly task: string;
};

export type ExtensionManagedSessionV2Terminal =
  | ExtensionManagedSessionTerminal
  | {
      readonly error: {
        readonly code: "managed_session_stalled";
        readonly message: "The managed review stalled without causal progress.";
      };
      readonly status: "failed";
    };

export type ExtensionOperationCapabilities = {
  readonly [EXTENSION_BIOME_CAPABILITY_ID]?: ExtensionBiomeCapability;
  readonly [EXTENSION_ARTIFACT_CAPABILITY_ID]?: ExtensionArtifactPublishCapability;
  readonly [EXTENSION_RECORDS_CAPABILITY_ID]?: ExtensionRecordCapability;
  readonly [EXTENSION_MANAGED_SESSION_CAPABILITY_ID]?: ExtensionManagedSessionCapability;
  readonly [EXTENSION_MANAGED_SESSION_V2_CAPABILITY_ID]?: ExtensionManagedSessionV2Capability;
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

export type ExtensionOperationManagedWaitStartedEvent = {
  readonly type: "operation_managed_wait_started";
  readonly remainingDeadlineMilliseconds: number;
};

export type ExtensionOperationManagedWaitSettledEvent = {
  readonly type: "operation_managed_wait_settled";
  readonly deadlineAt: string;
  readonly remainingDeadlineMilliseconds: number;
};

export type ExtensionOperationEvent =
  | ExtensionOperationArtifactPublishedEvent
  | ExtensionOperationCancelRequestedEvent
  | ExtensionOperationCancelledEvent
  | ExtensionOperationCompletedEvent
  | ExtensionOperationFailedEvent
  | ExtensionOperationInspectionRequiredEvent
  | ExtensionOperationManagedWaitSettledEvent
  | ExtensionOperationManagedWaitStartedEvent
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

function decodeProjectChangeSnapshot(
  value: unknown,
): ExtensionContractResult<ExtensionProjectChangeSnapshot> {
  const result = projectChangeSnapshotSchema.safeParse(value);
  if (result.success) {
    return { ok: true, value: result.data as ExtensionProjectChangeSnapshot };
  }
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      code: issue.code === "custom" ? issue.message : issue.code,
      path:
        issue.path.length === 0
          ? "/"
          : `/${issue.path.map((part) => escapeJsonPointer(String(part))).join("/")}`,
    })),
  };
}

function escapeJsonPointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function isProjectRelativePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    hasControlCharacter(path)
  ) {
    return false;
  }
  return path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function isStrictUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function parseExtensionPackageManifest(value: unknown): ExtensionPackageManifest {
  return extensionPackageManifestSchema.parse(value);
}
