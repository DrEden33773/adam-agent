import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGateway } from "@ai-sdk/gateway";

import { AiSdkModelDriver } from "./ai-sdk-model-driver.js";
import type { ModelDriver } from "./index.js";

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

export type ModelTargetSnapshot = {
  readonly targets: readonly {
    readonly identity: ModelTargetIdentity;
    readonly readiness: ModelTargetReadiness;
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
    if (modelId === "deepseek-v4-flash" || modelId === "deepseek-v4-pro") {
      return `${modelId}.direct`;
    }
    throw new ModelTargetError(
      "invalid_selector",
      "ADAM_AGENT_MODEL must be deepseek-v4-flash or deepseek-v4-pro when ADAM_AGENT_PROVIDER=deepseek.",
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
    readonly allowExperimental: boolean;
    readonly signal: AbortSignal;
  }): Promise<{ readonly identity: ModelTargetIdentity; readonly driver: ModelDriver }>;
  snapshot(input: {
    readonly discoverGateway?: boolean | undefined;
    readonly signal: AbortSignal;
  }): Promise<ModelTargetSnapshot>;
}

export type ModelTargetsOptions = {
  readonly environment: Readonly<{
    AI_GATEWAY_API_KEY?: string | undefined;
    DEEPSEEK_API_KEY?: string | undefined;
  }>;
  readonly deadlineMs?: number | undefined;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

const directDeepSeekTargets: readonly ModelTargetIdentity[] = Object.freeze([
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

const experimentalGatewayProviderId = "poolside";

const experimentalGatewayTarget: ModelTargetIdentity = Object.freeze({
  targetId: "poolside-laguna-s-2.1-free.gateway",
  vendor: "poolside",
  modelId: "poolside/laguna-s-2.1-free",
  route: "vercel-ai-gateway",
  upstreamProviderId: experimentalGatewayProviderId,
  profileVersion: 1,
  certification: "experimental",
});

export function createModelTargets(options: ModelTargetsOptions): ModelTargets {
  const deadlineMs = options.deadlineMs ?? 120_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new RangeError("The model request deadline must be a positive safe integer.");
  }
  return {
    async resolve(input) {
      const identity =
        directDeepSeekTargets.find((candidate) => candidate.targetId === input.targetId) ??
        (input.targetId === experimentalGatewayTarget.targetId
          ? experimentalGatewayTarget
          : undefined);
      if (identity === undefined) {
        throw new ModelTargetError(
          "target_not_found",
          "Unknown model target. Choose deepseek-v4-flash.direct, deepseek-v4-pro.direct, or the documented Experimental Gateway target.",
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
      return {
        identity,
        driver: new AiSdkModelDriver({
          model: provider(identity.modelId),
          maximumOutputTokens: 32_768,
          deadlineMs,
          sensitiveValues:
            options.environment.DEEPSEEK_API_KEY === undefined
              ? []
              : [options.environment.DEEPSEEK_API_KEY],
        }),
      };
    },
    async snapshot() {
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
          ...directDeepSeekTargets.map((identity) => ({
            identity,
            readiness: { status, credentialSource: "DEEPSEEK_API_KEY" },
          })),
          {
            identity: experimentalGatewayTarget,
            readiness: {
              status: gatewayStatus,
              credentialSource: "AI_GATEWAY_API_KEY",
            },
          },
        ],
      };
    },
  };
}

function hasCredential(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}
