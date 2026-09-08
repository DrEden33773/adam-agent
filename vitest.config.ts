import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.ts"],
    setupFiles: ["packages/testkit/src/test-environment.ts"],
    // Success remains tied to causal observables. This is only the outer failure guard for
    // real process and filesystem integration on slower supported CI runners.
    testTimeout: 30_000,
  },
});
