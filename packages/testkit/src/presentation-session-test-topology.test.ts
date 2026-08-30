import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const behaviorSuitePath = fileURLToPath(new URL("./presentation-session.test.ts", import.meta.url));
const operatingSystemSuitePath = fileURLToPath(
  new URL("./presentation-session.os.test.ts", import.meta.url),
);

const planSemanticTestNames = [
  "PresentationSession creates Plan revision intent without changing durable ready state",
  "PresentationSession submits revision feedback as one ordinary turn that stales ready state",
  "PresentationSession owns an approved Plan kickoff as the active cancellable run",
  "PresentationSession rejects stale approval and cancels only the exact current ready Plan artifact",
] as const;

const approvalRestartTestName =
  "PresentationSession recovers one durable Plan approval intent after a JSONL restart";

test("Plan Presentation semantics stay below JSONL while approval restart owns the durability adapter", async () => {
  const [behaviorSource, operatingSystemSource] = await Promise.all([
    readFile(behaviorSuitePath, "utf8"),
    readFile(operatingSystemSuitePath, "utf8"),
  ]);

  for (const testName of planSemanticTestNames) {
    const source = exactTestSource(behaviorSource, testName);
    expect.soft(source, testName).toContain("createInMemorySessionLifecycleHarness");
    expect.soft(source, testName).toContain("presentationSessionRecordReader");
    expect.soft(source, testName).not.toContain("openJsonlSessionStore");
    expect.soft(source, testName).not.toContain("createSessionLifecycle({");
  }

  const restartSource = exactTestSource(operatingSystemSource, approvalRestartTestName);
  expect.soft(restartSource).toContain("planApprovalIntentBarrier");
  expect.soft(restartSource).toContain("openJsonlSessionStore");
  expect.soft(restartSource).toContain("await lifecycle.close()");
  expect.soft(restartSource).toContain("approved_not_started");
});

function exactTestSource(source: string, name: string): string {
  const start = source.indexOf(`test("${name}"`);
  if (start < 0) {
    throw new Error(`Missing exact test: ${name}`);
  }
  const remainder = source.slice(start + 1);
  const nextTestOffset = remainder.search(/\ntest(?:\.each)?\(/u);
  return nextTestOffset < 0 ? source.slice(start) : source.slice(start, start + 1 + nextTestOffset);
}
