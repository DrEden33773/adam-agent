import type { McpToolProfileV1 } from "./mcp-profile-contracts.js";

type McpJsonRecord = Readonly<Record<string, unknown>> & {
  readonly $anchor?: unknown;
  readonly $dynamicAnchor?: unknown;
  readonly $dynamicRef?: unknown;
  readonly $id?: unknown;
  readonly $recursiveRef?: unknown;
  readonly $ref?: unknown;
  readonly $schema?: unknown;
  readonly properties?: unknown;
};

export type McpSchemaAdmission = {
  readonly schema: Readonly<Record<string, unknown>>;
  readonly dialect: McpToolProfileV1["tools"][number]["rawSchema"]["dialect"];
  readonly resolveProjectionBranch: (branch: unknown) => Readonly<Record<string, unknown>>;
};

const mcpSchemaLimits = {
  maximumBranches: 64,
  maximumBranchesPerCombinator: 16,
  maximumDefinitions: 64,
  maximumDepth: 32,
  maximumNodes: 1_024,
  maximumProperties: 256,
  maximumReferenceBytes: 512,
  maximumReferenceDepth: 16,
  maximumReferences: 128,
  maximumReferenceSegments: 32,
} as const;

export function admitMcpSchema(schema: Readonly<Record<string, unknown>>): McpSchemaAdmission {
  const root = schema as McpJsonRecord;
  const dialect = schemaDialect(root);
  assertMcpSchemaAdmissible(root);
  return {
    schema: root,
    dialect,
    resolveProjectionBranch: (branch) => resolveMcpProjectionBranch(root, branch),
  };
}

function assertMcpSchemaAdmissible(root: McpJsonRecord): void {
  let branchCount = 0;
  let definitionCount = 0;
  let nodeCount = 0;
  let propertyCount = 0;
  let referenceCount = 0;
  const activeObjects = new Set<McpJsonRecord>();

  const visit = (value: unknown, depth: number): void => {
    nodeCount += 1;
    if (nodeCount > mcpSchemaLimits.maximumNodes || depth > mcpSchemaLimits.maximumDepth) {
      throw new TypeError("MCP schema traversal limit exceeded.");
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    if (activeObjects.has(value)) {
      throw new TypeError("MCP schema reference cycle detected.");
    }
    activeObjects.add(value);
    try {
      const properties = value.properties;
      if (isRecord(properties)) {
        propertyCount += Object.keys(properties).length;
        if (propertyCount > mcpSchemaLimits.maximumProperties) {
          throw new TypeError("MCP schema property limit exceeded.");
        }
      }
      for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
        const branches = value[keyword];
        if (Array.isArray(branches)) {
          branchCount += branches.length;
          if (
            branches.length > mcpSchemaLimits.maximumBranchesPerCombinator ||
            branchCount > mcpSchemaLimits.maximumBranches
          ) {
            throw new TypeError("MCP schema branch limit exceeded.");
          }
        }
      }
      for (const keyword of ["$defs", "definitions"] as const) {
        const definitions = value[keyword];
        if (isRecord(definitions)) {
          definitionCount += Object.keys(definitions).length;
          if (definitionCount > mcpSchemaLimits.maximumDefinitions) {
            throw new TypeError("MCP schema definition limit exceeded.");
          }
        }
      }
      if (
        value.$dynamicRef !== undefined ||
        value.$recursiveRef !== undefined ||
        value.$id !== undefined ||
        value.$anchor !== undefined ||
        value.$dynamicAnchor !== undefined
      ) {
        throw new TypeError("MCP schema dynamic or alternate reference scopes are unsupported.");
      }
      const reference = value.$ref;
      if (reference !== undefined) {
        referenceCount += 1;
        if (
          typeof reference !== "string" ||
          Buffer.byteLength(reference, "utf8") > mcpSchemaLimits.maximumReferenceBytes ||
          reference.slice(2).split("/").length > mcpSchemaLimits.maximumReferenceSegments ||
          referenceCount > mcpSchemaLimits.maximumReferences ||
          (!reference.startsWith("#/$defs/") && !reference.startsWith("#/definitions/"))
        ) {
          throw new TypeError("MCP schema reference is not a supported bounded local reference.");
        }
        resolveLocalSchemaReference(root, reference);
      }
      for (const [key, child] of Object.entries(value)) {
        if (key !== "$ref") {
          visit(child, depth + 1);
        }
      }
    } finally {
      activeObjects.delete(value);
    }
  };

  visit(root, 0);
  validateMcpReferenceGraph(root, root, 0, new Set([root]));
}

function validateMcpReferenceGraph(
  root: McpJsonRecord,
  value: unknown,
  referenceDepth: number,
  activeTargets: Set<McpJsonRecord>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      validateMcpReferenceGraph(root, item, referenceDepth, activeTargets);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const reference = value.$ref;
  if (typeof reference === "string") {
    if (referenceDepth >= mcpSchemaLimits.maximumReferenceDepth) {
      throw new TypeError("MCP schema reference depth limit exceeded.");
    }
    const target = resolveLocalSchemaReference(root, reference);
    if (!isRecord(target) || activeTargets.has(target)) {
      throw new TypeError("MCP schema reference cycle detected.");
    }
    activeTargets.add(target);
    try {
      validateMcpReferenceGraph(root, target, referenceDepth + 1, activeTargets);
    } finally {
      activeTargets.delete(target);
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== "$ref") {
      validateMcpReferenceGraph(root, child, referenceDepth, activeTargets);
    }
  }
}

function resolveLocalSchemaReference(root: McpJsonRecord, reference: string): unknown {
  let current: unknown = root;
  for (const encodedSegment of reference.slice(2).split("/")) {
    const segment = encodedSegment.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      throw new TypeError("MCP schema local reference does not resolve.");
    }
    current = current[segment];
  }
  return current;
}

function resolveMcpProjectionBranch(
  root: McpJsonRecord,
  branch: unknown,
): Readonly<Record<string, unknown>> {
  let current = branch;
  const seen = new Set<McpJsonRecord>();
  for (let depth = 0; depth <= mcpSchemaLimits.maximumReferenceDepth; depth += 1) {
    if (!isRecord(current)) {
      throw new TypeError("MCP root combinator branches must be object schemas.");
    }
    const reference = current.$ref;
    if (reference === undefined) {
      return current;
    }
    if (typeof reference !== "string" || Object.keys(current).some((key) => key !== "$ref")) {
      throw new TypeError("MCP projected references cannot have sibling keywords.");
    }
    if (depth === mcpSchemaLimits.maximumReferenceDepth || seen.has(current)) {
      throw new TypeError("MCP projected reference depth or cycle limit exceeded.");
    }
    seen.add(current);
    current = resolveLocalSchemaReference(root, reference);
  }
  throw new TypeError("MCP projected reference depth limit exceeded.");
}

function schemaDialect(
  schema: McpJsonRecord,
): McpToolProfileV1["tools"][number]["rawSchema"]["dialect"] {
  const declared = schema.$schema;
  if (declared === undefined) {
    return "unstamped";
  }
  if (typeof declared !== "string") {
    throw new TypeError("MCP schema dialect declaration must be a string.");
  }
  const normalized = declared.replace(/#$/u, "");
  if (
    normalized === "https://json-schema.org/draft/2020-12/schema" ||
    normalized === "http://json-schema.org/draft/2020-12/schema"
  ) {
    return "2020-12";
  }
  if (
    normalized === "https://json-schema.org/draft/2019-09/schema" ||
    normalized === "http://json-schema.org/draft/2019-09/schema"
  ) {
    return "2019-09";
  }
  if (
    normalized === "http://json-schema.org/draft-07/schema" ||
    normalized === "https://json-schema.org/draft-07/schema"
  ) {
    return "draft-07";
  }
  if (
    normalized === "http://json-schema.org/draft-06/schema" ||
    normalized === "https://json-schema.org/draft-06/schema"
  ) {
    return "draft-06";
  }
  throw new TypeError("MCP schema dialect is unsupported.");
}

function isRecord(value: unknown): value is McpJsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
