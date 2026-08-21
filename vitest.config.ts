import { availableParallelism } from "node:os";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.ts"],
    // Keep the default CPU reserve on smaller runners while capping concurrent real PTYs,
    // child processes, and fsync-heavy fixtures before I/O contention slows every test.
    maxWorkers: Math.max(1, Math.min(9, availableParallelism() - 1)),
    setupFiles: ["packages/testkit/src/test-environment.ts"],
    // Success remains tied to causal observables. This is only the outer failure guard for
    // real process and filesystem integration on slower supported CI runners.
    testTimeout: 30_000,
  },
});
