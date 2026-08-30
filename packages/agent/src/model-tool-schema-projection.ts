import { ModelDriverError } from "./model-driver-error.js";
import type { ModelToolDefinition } from "./tool-runtime.js";

export type ModelToolSchemaProjectionProfile = "deepseek-function-parameters-v1";

type ToolSchemaRoot = Readonly<Record<string, unknown>> & {
  readonly type?: unknown;
  readonly oneOf?: unknown;
  readonly anyOf?: unknown;
};

export function projectModelToolDefinitions(
  tools: readonly ModelToolDefinition[],
  profile: ModelToolSchemaProjectionProfile,
): readonly ModelToolDefinition[] {
  switch (profile) {
    case "deepseek-function-parameters-v1":
      return tools.map((tool) => ({
        ...tool,
        inputSchema: projectDeepSeekFunctionParameters(tool.inputSchema),
      }));
  }
}

function projectDeepSeekFunctionParameters(
  schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const copy = structuredClone(schema) as ToolSchemaRoot;
  if (copy.type === "object") {
    return copy;
  }
  const oneOf = copy.oneOf;
  const anyOf = copy.anyOf;
  const branches = oneOf === undefined || anyOf === undefined ? (oneOf ?? anyOf) : undefined;
  if (
    copy.type === undefined &&
    Array.isArray(branches) &&
    branches.length > 0 &&
    branches.every(isObjectSchema)
  ) {
    return { ...copy, type: "object" };
  }
  throw new ModelDriverError(
    "protocol_incompatibility",
    "A model tool schema is incompatible with the Direct DeepSeek function interface.",
    {
      cause: undefined,
      diagnosticCode: "tool_schema_root_not_object",
    },
  );
}

function isObjectSchema(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as ToolSchemaRoot).type === "object"
  );
}
