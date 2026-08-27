import { createHash } from "node:crypto";

export type McpSha256Digest = `sha256:${string}`;

export function canonicalMcpJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalMcpJson(entry)).join(",")}]`;
  }
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalMcpJson(entry)}`)
    .join(",")}}`;
}

export function digestCanonicalMcpJson(value: unknown): McpSha256Digest {
  return `sha256:${createHash("sha256").update(canonicalMcpJson(value)).digest("hex")}`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
