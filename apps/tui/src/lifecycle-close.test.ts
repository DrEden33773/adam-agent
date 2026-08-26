import { expect, test } from "vitest";

import { findMcpShutdownUnconfirmedError, McpShutdownUnconfirmedError } from "./lifecycle-close.js";

test("MCP shutdown diagnosis survives an aggregate of independent cleanup failures", () => {
  const shutdownFailure = new McpShutdownUnconfirmedError("MCP shutdown could not be confirmed.");
  const failure = new AggregateError(
    [new Error("terminal restoration failed"), new AggregateError([shutdownFailure])],
    "cleanup failed",
  );

  expect(findMcpShutdownUnconfirmedError(failure)).toBe(shutdownFailure);
});

test("unrelated aggregate failures do not become MCP shutdown failures", () => {
  expect(findMcpShutdownUnconfirmedError(new AggregateError([new Error("clipboard failed")]))).toBe(
    undefined,
  );
});
