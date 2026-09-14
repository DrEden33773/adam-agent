import type { z } from "zod";

type InputFailure = {
  readonly success: false;
  readonly issues?: readonly z.core.$ZodIssue[];
  readonly jsonPosition?: number;
};

export function parseToolInput<T>(
  schema: z.ZodType<T>,
  argumentsJson: string,
): { readonly success: true; readonly data: T } | InputFailure {
  let input: unknown;
  try {
    input = JSON.parse(argumentsJson);
  } catch (error) {
    const location =
      error instanceof SyntaxError
        ? /at position (\d+)(?: \(line \d+ column \d+\))?$/.exec(error.message)?.[1]
        : undefined;
    const position = location === undefined ? undefined : Number(location);
    return {
      success: false,
      ...(position === undefined ||
      !Number.isSafeInteger(position) ||
      position > argumentsJson.length
        ? {}
        : { jsonPosition: position }),
    };
  }
  const parsed = schema.safeParse(input);
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, issues: parsed.error.issues };
}

export function toolInputFailure(failure: InputFailure, rules: Readonly<Record<string, string>>) {
  let message: string;
  if (failure.issues === undefined) {
    message = `input: supply one valid JSON object${failure.jsonPosition === undefined ? "" : `; syntax error at position ${failure.jsonPosition}`}.`;
  } else {
    const hints = failure.issues.slice(0, 3).map((issue) => {
      // Paths and issue messages can contain untrusted keys or values. Emit
      // only declared field names and bounded numeric locations, never values.
      let path = "";
      let field: string | undefined;
      for (const part of issue.path.slice(0, 6)) {
        if (typeof part === "string" && Object.hasOwn(rules, part)) {
          path += `${path ? "." : ""}${part}`;
          field = part;
        } else if (
          typeof part === "number" &&
          Number.isSafeInteger(part) &&
          part >= 0 &&
          part <= 999999
        ) {
          path += `[${part}]`;
        } else {
          break;
        }
      }
      const rule = field === undefined ? undefined : rules[field];
      const hint =
        issue.code === "unrecognized_keys"
          ? "remove unsupported fields and use only the declared fields"
          : (rule ?? "follow the declared object schema");
      return `${path || "input"}: ${hint}.`;
    });
    message = [...new Set(hints)].join(" ");
  }
  return {
    status: "failed" as const,
    error: { code: "invalid_tool_input" as const, message: message.slice(0, 768) },
  };
}
