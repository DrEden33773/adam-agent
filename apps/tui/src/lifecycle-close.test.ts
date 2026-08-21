import { expect, test } from "vitest";

import { requireConfirmedLifecycleClose } from "./lifecycle-close.js";

test("an unconfirmed MCP shutdown remains a visible process failure", () => {
  expect(() => requireConfirmedLifecycleClose({ status: "mcp_shutdown_unconfirmed" })).toThrow(
    "MCP shutdown could not be confirmed.",
  );
  expect(() => requireConfirmedLifecycleClose({ status: "closed" })).not.toThrow();
});
