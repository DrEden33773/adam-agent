import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGateway } from "@ai-sdk/gateway";
import type { ModelDriver, ModelModalityProfile } from "./agent-session-contracts.js";
import { AiSdkModelDriver } from "./ai-sdk-model-driver.js";
import type { ContextProfile } from "./context-profile.js";
import { DirectDeepSeekResponsesModelDriver } from "./deepseek-responses-model-driver.js";
import {
  createDirectDeepSeekResponsesThinkingCapability,
  createDirectDeepSeekThinkingCapability,
  type ThinkingCapabilityV1,
} from "./thinking-policy.js";

export type ModelTargetIdentity = {
  readonly targetId: string;
  readonly vendor: string;
  readonly modelId: string;
  readonly route: "direct" | "vercel-ai-gateway";
  readonly upstreamProviderId?: string;
  readonly profileVersion: number;
  readonly certification: "certified" | "experimental";
};

export type ModelTargetReadiness = {
  readonly status: "available" | "missing";
  readonly credentialSource: string;
};

export type ModelTargetCatalogMetadata = {
  readonly displayName: string;
  readonly summary: string;
  readonly capabilities: readonly ("reasoning" | "tool-use")[];
  readonly modalities: readonly ("text" | "image")[];
  readonly recommended: boolean;
};

export type ModelTargetSnapshot = {
  readonly targets: readonly {
    readonly identity: ModelTargetIdentity;
    readonly catalog?: ModelTargetCatalogMetadata;
    readonly readiness: ModelTargetReadiness;
    readonly contextProfile: ContextProfile;
    readonly modalityProfile?: ModelModalityProfile;
    readonly connectionTest?: "supported";
    readonly upstreamLifecycle?: "experimental" | "stable";
    readonly thinkingCapability?: ThinkingCapabilityV1;
  }[];
};

export class ModelTargetError extends Error {
  readonly code:
    | "credential_missing"
    | "experimental_not_allowed"
    | "invalid_selector"
    | "selector_conflict"
    | "target_not_found"
    | "target_not_selected";

  constructor(
    code:
      | "credential_missing"
      | "experimental_not_allowed"
      | "invalid_selector"
      | "selector_conflict"
      | "target_not_found"
      | "target_not_selected",
    message: string,
  ) {
    super(message);
    this.name = "ModelTargetError";
    this.code = code;
  }
}

export function selectModelTargetId(
  environment: Readonly<{
    ADAM_AGENT_TARGET?: string | undefined;
    ADAM_AGENT_PROVIDER?: string | undefined;
    ADAM_AGENT_MODEL?: string | undefined;
    DEEPSEEK_API_KEY?: string | undefined;
  }>,
): string {
  if (environment.ADAM_AGENT_TARGET !== undefined) {
    if (
      environment.ADAM_AGENT_PROVIDER !== undefined ||
      environment.ADAM_AGENT_MODEL !== undefined
    ) {
      throw new ModelTargetError(
        "selector_conflict",
        "ADAM_AGENT_TARGET cannot be combined with ADAM_AGENT_PROVIDER or ADAM_AGENT_MODEL.",
      );
    }
    return environment.ADAM_AGENT_TARGET;
  }
  if (
    environment.ADAM_AGENT_PROVIDER !== undefined &&
    environment.ADAM_AGENT_PROVIDER !== "deepseek"
  ) {
    throw new ModelTargetError(
      "invalid_selector",
      "ADAM_AGENT_PROVIDER must be unset or deepseek.",
    );
  }
  if (environment.ADAM_AGENT_PROVIDER === "deepseek") {
    const modelId = environment.ADAM_AGENT_MODEL ?? "deepseek-v4-pro";
    if (
      modelId === "deepseek-v4-flash" ||
      modelId === "deepseek-v4-pro" ||
      modelId === "deepseek-v4-flash-vision-exp"
    ) {
      return `${modelId}.direct`;
    }
    throw new ModelTargetError(
      "invalid_selector",
      "ADAM_AGENT_MODEL must be deepseek-v4-flash, deepseek-v4-pro, or deepseek-v4-flash-vision-exp when ADAM_AGENT_PROVIDER=deepseek.",
    );
  }
  if (environment.ADAM_AGENT_MODEL !== undefined) {
    throw new ModelTargetError(
      "invalid_selector",
      "ADAM_AGENT_MODEL requires ADAM_AGENT_PROVIDER=deepseek during compatibility migration.",
    );
  }
  throw new ModelTargetError(
    "target_not_selected",
    "No model target selected. Set ADAM_AGENT_TARGET=deepseek-v4-flash.direct or ADAM_AGENT_TARGET=fake.local.",
  );
}

export interface ModelTargets {
  resolve(input: {
    readonly targetId: string;
    readonly targetIdentity?: ModelTargetIdentity | undefined;
    readonly allowExperimental: boolean;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly identity: ModelTargetIdentity;
    readonly driver: ModelDriver;
    readonly contextProfile: ContextProfile;
    readonly modalityProfile?: ModelModalityProfile;
    readonly upstreamLifecycle?: "experimental" | "stable";
    readonly thinkingCapability?: ThinkingCapabilityV1;
  }>;
  snapshot(input: {
    readonly discoverGateway?: boolean | undefined;
    readonly includeHistoricalProfiles?: boolean | undefined;
    readonly signal: AbortSignal;
  }): Promise<ModelTargetSnapshot>;
  readonly testConnection?: (input: {
    readonly targetId: string;
    readonly signal: AbortSignal;
  }) => Promise<ModelTargetConnectionTestResult>;
}

export type ModelTargetConnectionTestResult = {
  readonly status: "reachable" | "unreachable";
  readonly diagnostic: {
    readonly code:
      | "connection_http_error"
      | "connection_model_not_advertised"
      | "connection_request_failed"
      | "connection_response_invalid"
      | "connection_response_too_large"
      | "connection_timeout"
      | "connection_unsupported";
    readonly message: string;
  } | null;
};

export type ModelTargetsOptions = {
  readonly environment: Readonly<{
    AI_GATEWAY_API_KEY?: string | undefined;
    DEEPSEEK_API_KEY?: string | undefined;
  }>;
  readonly deadlineMs?: number | undefined;
  readonly connectionDeadlineMs?: number | undefined;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

const maximumConnectionResponseBytes = 256 * 1024;
const maximumAdvertisedModels = 4_096;
const maximumAdvertisedModelIdBytes = 512;

const directDeepSeekV1Targets: readonly ModelTargetIdentity[] = Object.freeze([
  Object.freeze({
    targetId: "deepseek-v4-flash.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-flash",
    route: "direct",
    profileVersion: 1,
    certification: "certified",
  }),
  Object.freeze({
    targetId: "deepseek-v4-pro.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-pro",
    route: "direct",
    profileVersion: 1,
    certification: "certified",
  }),
]);
const directDeepSeekV2Targets: readonly ModelTargetIdentity[] = Object.freeze(
  directDeepSeekV1Targets.map((identity) => Object.freeze({ ...identity, profileVersion: 2 })),
);
const directDeepSeekV3Targets: readonly ModelTargetIdentity[] = Object.freeze(
  directDeepSeekV2Targets.map((identity) => Object.freeze({ ...identity, profileVersion: 3 })),
);
const directDeepSeekVisionChatV1Target: ModelTargetIdentity = Object.freeze({
  targetId: "deepseek-v4-flash-vision-exp.direct",
  vendor: "deepseek",
  modelId: "deepseek-v4-flash-vision-exp",
  route: "direct",
  profileVersion: 1,
  certification: "certified",
});
const directDeepSeekVisionResponsesV2Target: ModelTargetIdentity = Object.freeze({
  ...directDeepSeekVisionChatV1Target,
  profileVersion: 2,
});
const directDeepSeekVisionChatV1ModalityProfile: ModelModalityProfile = Object.freeze({
  profileVersion: 1,
  explicitUserImages: "supported",
  imageToolResults: "unsupported",
});
const directDeepSeekVisionResponsesV2ModalityProfile: ModelModalityProfile = Object.freeze({
  profileVersion: 1,
  explicitUserImages: "unsupported",
  imageToolResults: "supported",
});
const currentDirectDeepSeekTargets = Object.freeze([
  ...directDeepSeekV3Targets,
  directDeepSeekVisionResponsesV2Target,
]);
const supportedDirectDeepSeekTargets = Object.freeze([
  ...directDeepSeekV3Targets,
  ...directDeepSeekV2Targets,
  ...directDeepSeekV1Targets,
  directDeepSeekVisionResponsesV2Target,
  directDeepSeekVisionChatV1Target,
]);

const experimentalGatewayProviderId = "poolside";
const directDeepSeekContextProfileV1: ContextProfile = Object.freeze({
  version: 1,
  contextWindowTokens: 1_000_000,
  maximumOutputTokens: 32_768,
  compactAtTokens: 800_000,
  postCompactTargetTokens: 200_000,
  retainedTargetTokens: 20_000,
  estimatorVersion: 1,
});
export const preparedDirectDeepSeekV2ContextProfile: ContextProfile = Object.freeze({
  version: 2,
  contextWindowTokens: 1_000_000,
  maximumOutputTokens: 384_000,
  ordinaryOutputReserveTokens: 4_096,
  compactionSummaryMaximumOutputTokens: 32_768,
  compactAtTokens: 900_000,
  postCompactTargetTokens: 200_000,
  retainedTargetTokens: 20_000,
  estimatorVersion: 1,
});
const experimentalGatewayContextProfile: ContextProfile = Object.freeze({
  version: 1,
  contextWindowTokens: 65_536,
  maximumOutputTokens: 32_768,
  compactAtTokens: 32_768,
  postCompactTargetTokens: 24_576,
  retainedTargetTokens: 8_192,
  estimatorVersion: 1,
});

const experimentalGatewayTarget: ModelTargetIdentity = Object.freeze({
  targetId: "poolside-laguna-s-2.1-free.gateway",
  vendor: "poolside",
  modelId: "poolside/laguna-s-2.1-free",
  route: "vercel-ai-gateway",
  upstreamProviderId: experimentalGatewayProviderId,
  profileVersion: 1,
  certification: "experimental",
});

const directFlashCatalog: ModelTargetCatalogMetadata = Object.freeze({
  displayName: "DeepSeek V4 Flash",
  summary: "Fast general-purpose coding model.",
  capabilities: Object.freeze(["reasoning", "tool-use"] as const),
  modalities: Object.freeze(["text"] as const),
  recommended: true,
});
const directProCatalog: ModelTargetCatalogMetadata = Object.freeze({
  displayName: "DeepSeek V4 Pro",
  summary: "Higher-capability coding model for complex work.",
  capabilities: Object.freeze(["reasoning", "tool-use"] as const),
  modalities: Object.freeze(["text"] as const),
  recommended: false,
});
const directVisionCatalog: ModelTargetCatalogMetadata = Object.freeze({
  displayName: "DeepSeek V4 Flash Vision",
  summary: "Vision-capable coding model for image-aware work.",
  capabilities: Object.freeze(["reasoning", "tool-use"] as const),
  modalities: Object.freeze(["text", "image"] as const),
  recommended: false,
});
const experimentalGatewayCatalog: ModelTargetCatalogMetadata = Object.freeze({
  displayName: "Poolside Laguna S 2.1 Free",
  summary: "Experimental free coding route through Vercel AI Gateway.",
  capabilities: Object.freeze(["tool-use"] as const),
  modalities: Object.freeze(["text"] as const),
  recommended: false,
});

export function createModelTargets(options: ModelTargetsOptions): ModelTargets {
  const deadlineMs = options.deadlineMs ?? 120_000;
  const connectionDeadlineMs = options.connectionDeadlineMs ?? 10_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new RangeError("The model request deadline must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(connectionDeadlineMs) || connectionDeadlineMs <= 0) {
    throw new RangeError("The model connection-test deadline must be a positive safe integer.");
  }
  return {
    async testConnection(input) {
      const identity = currentDirectDeepSeekTargets.find(
        (candidate) => candidate.targetId === input.targetId,
      );
      if (identity === undefined) {
        return connectionFailure(
          "connection_unsupported",
          "The selected target does not support this connection test.",
        );
      }
      if (!hasCredential(options.environment.DEEPSEEK_API_KEY)) {
        return connectionFailure(
          "connection_request_failed",
          "The selected target is not configured with its required credential.",
        );
      }
      input.signal.throwIfAborted();
      const deadline = new AbortController();
      const abortFromCaller = () => deadline.abort(input.signal.reason);
      input.signal.addEventListener("abort", abortFromCaller, { once: true });
      const timer = setTimeout(
        () => deadline.abort(new DOMException("Connection test deadline reached.", "TimeoutError")),
        connectionDeadlineMs,
      );
      try {
        const fetcher = options.fetch ?? globalThis.fetch;
        const response = await fetcher("https://api.deepseek.com/models", {
          method: "GET",
          headers: { authorization: `Bearer ${options.environment.DEEPSEEK_API_KEY}` },
          signal: deadline.signal,
        });
        if (!response.ok) {
          return connectionFailure(
            "connection_http_error",
            `The authenticated model catalog returned HTTP ${response.status}.`,
          );
        }
        const body = await readBoundedConnectionBody(response, maximumConnectionResponseBytes);
        if (body === undefined) {
          return connectionFailure(
            "connection_response_too_large",
            "The authenticated model catalog exceeded Adam's response limit.",
          );
        }
        const advertised = advertisedModelIds(body);
        if (advertised === undefined) {
          return connectionFailure(
            "connection_response_invalid",
            "The authenticated model catalog response is invalid.",
          );
        }
        if (!advertised.has(identity.modelId)) {
          return connectionFailure(
            "connection_model_not_advertised",
            "The authenticated model catalog did not advertise the expected exact model.",
          );
        }
        return { status: "reachable", diagnostic: null };
      } catch {
        if (input.signal.aborted) {
          input.signal.throwIfAborted();
        }
        if (deadline.signal.aborted) {
          return connectionFailure(
            "connection_timeout",
            "The authenticated model catalog request reached its deadline.",
          );
        }
        return connectionFailure(
          "connection_request_failed",
          "The authenticated model catalog request failed.",
        );
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", abortFromCaller);
      }
    },
    async resolve(input) {
      const requestedIdentity = input.targetIdentity;
      const identity =
        requestedIdentity !== undefined && requestedIdentity.targetId !== input.targetId
          ? undefined
          : requestedIdentity === undefined
            ? (currentDirectDeepSeekTargets.find(
                (candidate) => candidate.targetId === input.targetId,
              ) ??
              (input.targetId === experimentalGatewayTarget.targetId
                ? experimentalGatewayTarget
                : undefined))
            : [...supportedDirectDeepSeekTargets, experimentalGatewayTarget].find((candidate) =>
                sameModelTargetIdentity(candidate, requestedIdentity),
              );
      if (identity === undefined) {
        throw new ModelTargetError(
          "target_not_found",
          "Unknown model target. Choose deepseek-v4-flash.direct, deepseek-v4-pro.direct, deepseek-v4-flash-vision-exp.direct, or the documented Experimental Gateway target.",
        );
      }
      if (identity.certification === "experimental" && !input.allowExperimental) {
        throw new ModelTargetError(
          "experimental_not_allowed",
          `${identity.targetId} is Experimental and non-certifying. Explicit opt-in is required.`,
        );
      }
      if (identity.route === "vercel-ai-gateway") {
        if (!hasCredential(options.environment.AI_GATEWAY_API_KEY)) {
          throw new ModelTargetError(
            "credential_missing",
            "AI_GATEWAY_API_KEY is required for the Experimental Gateway target. Set it and retry the same target.",
          );
        }
        const provider = createGateway({
          ...(options.environment.AI_GATEWAY_API_KEY === undefined
            ? {}
            : { apiKey: options.environment.AI_GATEWAY_API_KEY }),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
        return {
          identity,
          contextProfile: experimentalGatewayContextProfile,
          driver: new AiSdkModelDriver({
            model: provider(identity.modelId),
            maximumOutputTokens: 32_768,
            deadlineMs,
            providerOptions: {
              gateway: { only: [experimentalGatewayProviderId] },
            },
            sensitiveValues:
              options.environment.AI_GATEWAY_API_KEY === undefined
                ? []
                : [options.environment.AI_GATEWAY_API_KEY],
          }),
        };
      }
      if (!hasCredential(options.environment.DEEPSEEK_API_KEY)) {
        throw new ModelTargetError(
          "credential_missing",
          `DEEPSEEK_API_KEY is required for ${identity.targetId}. Set it and retry the same target.`,
        );
      }
      const provider = createDeepSeek({
        ...(options.environment.DEEPSEEK_API_KEY === undefined
          ? {}
          : { apiKey: options.environment.DEEPSEEK_API_KEY }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      const contextProfile = directDeepSeekContextProfileFor(identity);
      if (sameModelTargetIdentity(identity, directDeepSeekVisionResponsesV2Target)) {
        return {
          identity,
          contextProfile,
          connectionTest: "supported" as const,
          modalityProfile: directDeepSeekVisionResponsesV2ModalityProfile,
          upstreamLifecycle: "experimental" as const,
          thinkingCapability: createDirectDeepSeekResponsesThinkingCapability(identity),
          driver: new DirectDeepSeekResponsesModelDriver({
            apiKey: options.environment.DEEPSEEK_API_KEY as string,
            baseURL: "https://api.deepseek.com",
            model: identity.modelId,
            maximumOutputTokens: contextProfile.maximumOutputTokens,
            deadlineMs,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          }),
        };
      }
      return {
        identity,
        contextProfile,
        connectionTest: "supported" as const,
        ...(identity.targetId === directDeepSeekVisionChatV1Target.targetId
          ? {
              modalityProfile: directDeepSeekVisionChatV1ModalityProfile,
              upstreamLifecycle: "experimental" as const,
            }
          : {}),
        thinkingCapability: createDirectDeepSeekThinkingCapability(identity),
        driver: new AiSdkModelDriver({
          model: provider(identity.modelId),
          maximumOutputTokens: contextProfile.maximumOutputTokens,
          deadlineMs,
          toolSchemaProjection: "deepseek-function-parameters-v1",
          sideCallThinkingPolicies: {
            title: {
              requestPath: "provider_options.deepseek",
              thinkingType: "disabled",
            },
            compaction: {
              requestPath: "provider_options.deepseek",
              thinkingType: "enabled",
              reasoningEffort: "high",
            },
          },
          sensitiveValues:
            options.environment.DEEPSEEK_API_KEY === undefined
              ? []
              : [options.environment.DEEPSEEK_API_KEY],
        }),
      };
    },
    async snapshot(input) {
      const status: ModelTargetReadiness["status"] = hasCredential(
        options.environment.DEEPSEEK_API_KEY,
      )
        ? "available"
        : "missing";
      const gatewayStatus: ModelTargetReadiness["status"] = hasCredential(
        options.environment.AI_GATEWAY_API_KEY,
      )
        ? "available"
        : "missing";
      return {
        targets: [
          ...(input.includeHistoricalProfiles
            ? supportedDirectDeepSeekTargets
            : currentDirectDeepSeekTargets
          ).map((identity) => ({
            identity,
            catalog: catalogMetadataFor(identity),
            readiness: { status, credentialSource: "DEEPSEEK_API_KEY" },
            contextProfile: directDeepSeekContextProfileFor(identity),
            connectionTest: "supported" as const,
            ...(sameModelTargetIdentity(identity, directDeepSeekVisionResponsesV2Target)
              ? {
                  modalityProfile: directDeepSeekVisionResponsesV2ModalityProfile,
                  upstreamLifecycle: "experimental" as const,
                }
              : identity.targetId === directDeepSeekVisionChatV1Target.targetId
                ? {
                    modalityProfile: directDeepSeekVisionChatV1ModalityProfile,
                    upstreamLifecycle: "experimental" as const,
                  }
                : {}),
            thinkingCapability: sameModelTargetIdentity(
              identity,
              directDeepSeekVisionResponsesV2Target,
            )
              ? createDirectDeepSeekResponsesThinkingCapability(identity)
              : createDirectDeepSeekThinkingCapability(identity),
          })),
          {
            identity: experimentalGatewayTarget,
            catalog: experimentalGatewayCatalog,
            readiness: {
              status: gatewayStatus,
              credentialSource: "AI_GATEWAY_API_KEY",
            },
            contextProfile: experimentalGatewayContextProfile,
          },
        ],
      };
    },
  };
}

function catalogMetadataFor(identity: ModelTargetIdentity): ModelTargetCatalogMetadata {
  if (identity.targetId === "deepseek-v4-flash.direct") {
    return directFlashCatalog;
  }
  if (identity.targetId === "deepseek-v4-pro.direct") {
    return directProCatalog;
  }
  if (identity.targetId === "deepseek-v4-flash-vision-exp.direct") {
    return directVisionCatalog;
  }
  throw new TypeError(`Missing catalog metadata for model target ${identity.targetId}.`);
}

function connectionFailure(
  code: NonNullable<ModelTargetConnectionTestResult["diagnostic"]>["code"],
  message: string,
): ModelTargetConnectionTestResult {
  return { status: "unreachable", diagnostic: { code, message } };
}

async function readBoundedConnectionBody(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array | undefined> {
  if (response.body === null) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        break;
      }
      byteCount += part.value.byteLength;
      if (byteCount > maximumBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function advertisedModelIds(body: Uint8Array): ReadonlySet<string> | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return undefined;
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    !("data" in decoded) ||
    !Array.isArray(decoded.data) ||
    decoded.data.length > maximumAdvertisedModels
  ) {
    return undefined;
  }
  const ids = new Set<string>();
  for (const entry of decoded.data) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("id" in entry) ||
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      Buffer.byteLength(entry.id, "utf8") > maximumAdvertisedModelIdBytes
    ) {
      return undefined;
    }
    ids.add(entry.id);
  }
  return ids;
}

function hasCredential(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function directDeepSeekContextProfileFor(identity: ModelTargetIdentity): ContextProfile {
  if (
    identity.targetId === directDeepSeekVisionChatV1Target.targetId ||
    identity.targetId === directDeepSeekVisionResponsesV2Target.targetId
  ) {
    return preparedDirectDeepSeekV2ContextProfile;
  }
  if (identity.profileVersion === 1) {
    return directDeepSeekContextProfileV1;
  }
  if (identity.profileVersion === 2 || identity.profileVersion === 3) {
    return preparedDirectDeepSeekV2ContextProfile;
  }
  throw new RangeError("The Direct DeepSeek context profile is not supported.");
}

export function sameModelTargetIdentity(
  left: ModelTargetIdentity,
  right: ModelTargetIdentity,
): boolean {
  return (
    left.targetId === right.targetId &&
    left.vendor === right.vendor &&
    left.modelId === right.modelId &&
    left.route === right.route &&
    left.upstreamProviderId === right.upstreamProviderId &&
    left.profileVersion === right.profileVersion &&
    left.certification === right.certification
  );
}

export function modelTargetUsesContextProfile(
  identity: ModelTargetIdentity,
  contextProfile: ContextProfile,
): boolean {
  const expectedContextProfileVersion =
    identity.vendor === "deepseek" &&
    identity.route === "direct" &&
    ((identity.modelId === "deepseek-v4-flash" || identity.modelId === "deepseek-v4-pro") &&
    identity.profileVersion === 3
      ? true
      : identity.modelId === "deepseek-v4-flash-vision-exp")
      ? 2
      : identity.profileVersion;
  return contextProfile.version === expectedContextProfileVersion;
}
