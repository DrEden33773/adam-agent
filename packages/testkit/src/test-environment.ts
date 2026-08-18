import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll } from "vitest";

const isolatedHome = mkdtempSync(join(tmpdir(), "adam-agent-test-home-"));
const testEnvironment = process.env as NodeJS.ProcessEnv & { HOME?: string };
testEnvironment.HOME = isolatedHome;

afterAll(() => {
  rmSync(isolatedHome, { recursive: true, force: true });
});
