import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";

type McpConfigurationRecord = Readonly<Record<string, unknown>> & {
  readonly mcpServers?: unknown;
};

export type McpConfigurationDocument = {
  readonly sourceDigest: `sha256:${string}`;
  readonly servers: readonly {
    readonly serverId: string;
    readonly configuration: Readonly<Record<string, unknown>>;
  }[];
};

const knownMcpServerConfigurationFields = new Set([
  "type",
  "command",
  "args",
  "cwd",
  "env",
  "url",
  "headers",
  "oauth",
  "socket",
  "resources",
  "prompts",
  "lifecycle",
  "credentials",
]);

export function inspectMcpConfigurationDocument(
  bytes: Buffer,
): McpConfigurationDocument | undefined {
  if (!isUtf8(bytes)) {
    throw new TypeError("The MCP configuration is not valid UTF-8.");
  }
  const parsed = parseJsonWithoutDuplicateKeys(bytes.toString("utf8"));
  if (!isMcpConfigurationRecord(parsed) || Object.keys(parsed).length !== 1) {
    return undefined;
  }
  const mcpServers = parsed.mcpServers;
  if (!isMcpServerConfigurations(mcpServers)) {
    return undefined;
  }
  return {
    sourceDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    servers: Object.entries(mcpServers)
      .map(([serverId, configuration]) => ({ serverId, configuration }))
      .sort(({ serverId: left }, { serverId: right }) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
  };
}

function parseJsonWithoutDuplicateKeys(source: string): unknown {
  let index = 0;
  const skipWhitespace = () => {
    while (/\s/u.test(source[index] ?? "")) {
      index += 1;
    }
  };
  const fail = (): never => {
    throw new SyntaxError("Invalid or duplicate-key JSON.");
  };
  const parseString = (): string => {
    if (source[index] !== '"') {
      return fail();
    }
    const start = index;
    index += 1;
    while (index < source.length) {
      const character = source[index];
      if (character === "\\") {
        index += 2;
        continue;
      }
      index += 1;
      if (character === '"') {
        return JSON.parse(source.slice(start, index)) as string;
      }
    }
    return fail();
  };
  const parseValue = (depth: number): unknown => {
    if (depth > 128) {
      return fail();
    }
    skipWhitespace();
    const character = source[index];
    if (character === '"') {
      return parseString();
    }
    if (character === "{") {
      index += 1;
      skipWhitespace();
      const entries: [string, unknown][] = [];
      const keys = new Set<string>();
      if (source[index] === "}") {
        index += 1;
        return Object.fromEntries(entries);
      }
      for (;;) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) {
          return fail();
        }
        keys.add(key);
        skipWhitespace();
        if (source[index] !== ":") {
          return fail();
        }
        index += 1;
        entries.push([key, parseValue(depth + 1)]);
        skipWhitespace();
        if (source[index] === "}") {
          index += 1;
          return Object.fromEntries(entries);
        }
        if (source[index] !== ",") {
          return fail();
        }
        index += 1;
      }
    }
    if (character === "[") {
      index += 1;
      skipWhitespace();
      const values: unknown[] = [];
      if (source[index] === "]") {
        index += 1;
        return values;
      }
      for (;;) {
        values.push(parseValue(depth + 1));
        skipWhitespace();
        if (source[index] === "]") {
          index += 1;
          return values;
        }
        if (source[index] !== ",") {
          return fail();
        }
        index += 1;
      }
    }
    for (const [literal, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (source.startsWith(literal, index)) {
        index += literal.length;
        return value;
      }
    }
    const start = index;
    while (/[0-9eE+.-]/u.test(source[index] ?? "")) {
      index += 1;
    }
    if (index === start) {
      return fail();
    }
    const number = JSON.parse(source.slice(start, index)) as unknown;
    if (typeof number !== "number" || !Number.isFinite(number)) {
      return fail();
    }
    return number;
  };
  const value = parseValue(0);
  skipWhitespace();
  if (index !== source.length) {
    return fail();
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMcpConfigurationRecord(value: unknown): value is McpConfigurationRecord {
  return isRecord(value);
}

function isMcpServerConfigurations(
  value: unknown,
): value is Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  return (
    isRecord(value) &&
    Object.keys(value).length <= 8 &&
    Object.entries(value).every(
      ([serverId, configuration]) =>
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(serverId) &&
        isRecord(configuration) &&
        Object.keys(configuration).every((key) => knownMcpServerConfigurationFields.has(key)),
    )
  );
}
