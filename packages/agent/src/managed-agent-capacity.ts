import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  createOwnerConfigurationFileStorage,
  hasDuplicateJsonObjectKey,
} from "./secure-user-configuration.js";

export const backgroundCapacitySchema = z.union([
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  z.literal("unlimited"),
]);
export type BackgroundCapacity = z.infer<typeof backgroundCapacitySchema>;

const configurationSchema = z.strictObject({
  version: z.literal(1),
  backgroundRunning: backgroundCapacitySchema,
});

export class ManagedAgentCapacityConfigurationError extends Error {
  constructor(
    readonly code:
      | "managed_agent_capacity_configuration_invalid"
      | "managed_agent_capacity_configuration_unsafe"
      | "managed_agent_capacity_configuration_unavailable",
  ) {
    super(
      code === "managed_agent_capacity_configuration_invalid"
        ? "The Main session's background capacity configuration is invalid."
        : code === "managed_agent_capacity_configuration_unsafe"
          ? "The Main session's background capacity configuration is unsafe."
          : "The Main session's background capacity configuration could not be saved.",
    );
    this.name = "ManagedAgentCapacityConfigurationError";
  }
}

export async function createManagedAgentCapacityConfiguration(options: {
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly parentSessionId: string;
}): Promise<{
  load(): Promise<BackgroundCapacity | undefined>;
  save(running: BackgroundCapacity): Promise<void>;
}> {
  const parentSessionId = z.uuid().parse(options.parentSessionId);
  const workspace = await realpath(options.workspaceRoot);
  const projectKey = createHash("sha256").update(workspace).digest("hex");
  const directoryPath = join(resolve(options.stateRoot), "projects", projectKey, "managed-agents");
  const storage = createOwnerConfigurationFileStorage({
    directoryPath,
    configurationPath: join(directoryPath, `capacity-${parentSessionId}.json`),
    maximumBytes: 1024,
    temporaryPrefix: `.capacity-${parentSessionId}`,
  });
  return {
    async load() {
      const stored = await storage.read();
      if (stored.status === "missing") return undefined;
      if (stored.status === "unsafe")
        throw new ManagedAgentCapacityConfigurationError(
          "managed_agent_capacity_configuration_unsafe",
        );
      try {
        if (hasDuplicateJsonObjectKey(stored.text)) throw new TypeError("Duplicate field.");
        return configurationSchema.parse(JSON.parse(stored.text)).backgroundRunning;
      } catch {
        throw new ManagedAgentCapacityConfigurationError(
          "managed_agent_capacity_configuration_invalid",
        );
      }
    },
    async save(running) {
      const configuration = configurationSchema.parse({ version: 1, backgroundRunning: running });
      try {
        await storage.write(`${JSON.stringify(configuration)}\n`);
      } catch {
        throw new ManagedAgentCapacityConfigurationError(
          "managed_agent_capacity_configuration_unavailable",
        );
      }
    },
  };
}
