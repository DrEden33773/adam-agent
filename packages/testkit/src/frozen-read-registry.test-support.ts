import { createReadToolRegistry, type ToolRegistry } from "@adam-agent/agent";

// Preserve the admitted prefix-read identity used by historical context/restart fixtures.
// These are production adapters, not mocked reads; current range behavior has its own OS suite.
export function createFrozenPrefixReadRegistry(options: {
  readonly workspaceRoot: string;
}): ToolRegistry {
  const registry = createReadToolRegistry(options);
  const read = registry
    .resolve("read_file")
    ?.retainedVersions?.find(
      (adapter) =>
        adapter.definitionDigest ===
        "sha256:bf60993d76a5fb881b188f859c7791c7db6811b80072d8f36e94592514f5678f",
    );
  if (read === undefined)
    throw new Error("The historical prefix-read adapter must remain available.");
  return {
    definitions: () =>
      registry
        .definitions()
        .map((definition) => (definition.name === "read_file" ? read.definition : definition)),
    resolve: (name) => (name === "read_file" ? read : registry.resolve(name)),
  };
}
