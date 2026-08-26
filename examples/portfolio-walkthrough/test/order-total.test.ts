import assert from "node:assert/strict";

import { calculateOrderTotalCents } from "../src/order-total.ts";

const testName = "applies the quantity discount to the subtotal in integer cents";

try {
  assert.equal(calculateOrderTotalCents(1_000, 3), 2_700);
  process.stdout.write(`✔ ${testName}\n`);
} catch (error) {
  process.stdout.write(`✖ ${testName}\n${formatError(error)}\n`, () => {
    process.exitCode = 1;
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
