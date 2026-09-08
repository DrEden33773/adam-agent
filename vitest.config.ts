import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.ts"],
    setupFiles: ["packages/testkit/src/test-environment.ts"],
    // Concurrent JSONL/PTY files share disk and process resources. Keep the
    // existing lower CPU allowance while bounding contention on larger hosts.
    maxWorkers: Math.min(4, Math.max(1, availableParallelism() - 1)),
    // Success remains tied to causal observables. This is only the outer failure guard for
    // real process and filesystem integration on slower supported CI runners.
    testTimeout: 30_000,
  },
});
