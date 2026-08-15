import { valid, validRange } from "semver";
import { z } from "zod";

export const EXTENSION_API_VERSION = "0.1.0";

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
});

const extensionPackageManifestSchema = z
  .object({
    name: z.string().min(1),
    version: z
      .string()
      .min(1)
      .refine((version) => valid(version) !== null),
    type: z.literal("module"),
    adamAgent: z.strictObject({
      id: z.string().min(1),
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
  execute(input: unknown, context: unknown): Promise<unknown> | unknown;
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
