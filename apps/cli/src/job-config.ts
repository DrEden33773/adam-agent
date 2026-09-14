import { isAbsolute } from "node:path";

export type JobConfig = {
  version: 1;
  prompt: string;
  target: string;
  stateRoot: string;
  configurationRoot: string;
  trustWorkspace: boolean;
  maxTurns: number;
  timeoutMs: number;
  maxTokens?: number;
  thinking?: "off" | "low" | "high" | "max";
  modelRelay?: string;
};

export function parseJobConfig(value: unknown): JobConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Job configuration must be an object.");
  }
  const config = value as { [K in keyof JobConfig]?: unknown };
  const keys = new Set([
    "version",
    "prompt",
    "target",
    "stateRoot",
    "configurationRoot",
    "trustWorkspace",
    "maxTurns",
    "timeoutMs",
    "maxTokens",
    "thinking",
    "modelRelay",
  ]);
  if (Object.keys(config).some((key) => !keys.has(key))) {
    throw new Error("Unknown job configuration field.");
  }
  if (config.version !== 1 || typeof config.trustWorkspace !== "boolean") {
    throw new Error("Job version 1 and explicit trustWorkspace are required.");
  }
  for (const key of ["prompt", "target", "stateRoot", "configurationRoot"] as const) {
    if (typeof config[key] !== "string" || config[key].length === 0) {
      throw new Error(`Job ${key} must be a nonempty string.`);
    }
  }
  for (const key of ["stateRoot", "configurationRoot"] as const) {
    if (!isAbsolute(config[key] as string)) throw new Error(`Job ${key} must be absolute.`);
  }
  for (const key of ["maxTurns", "timeoutMs", "maxTokens"] as const) {
    if (key === "maxTokens" && config[key] === undefined) continue;
    if (!Number.isSafeInteger(config[key]) || (config[key] as number) <= 0) {
      throw new Error(`Job ${key} must be a positive safe integer.`);
    }
  }
  if ((config.timeoutMs as number) > 2_147_483_647) throw new Error("Job timeout is too large.");
  if (
    config.thinking !== undefined &&
    !["off", "low", "high", "max"].includes(config.thinking as string)
  ) {
    throw new Error("Unsupported job thinking level.");
  }
  if (config.modelRelay !== undefined) {
    if (typeof config.modelRelay !== "string" || config.target !== "deepseek-flash.direct") {
      throw new Error("Model relay requires the DeepSeek Flash Responses target.");
    }
    const url = new URL(config.modelRelay);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("Model relay must be an HTTP(S) origin without credentials or query.");
    }
    if (url.pathname !== "/") throw new Error("Model relay must be an origin.");
  }
  return config as JobConfig;
}
