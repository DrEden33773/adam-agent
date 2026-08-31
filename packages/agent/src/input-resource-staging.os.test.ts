import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createFileTurnComposerResourceStager } from "./input-resource-staging.js";

test("file turn-composer staging retains recoverable provisional bytes across close", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-turn-staging-retain-"));
  const artifactRoot = join(testRoot, "artifacts");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "notes.txt");
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, "retained draft bytes\n", "utf8");
  const stager = await createFileTurnComposerResourceStager({ artifactRoot });

  try {
    const selection = await stager.stage({
      id: crypto.randomUUID(),
      path: selectedPath,
      signal: new AbortController().signal,
    });
    await stager.retain({ resourceId: crypto.randomUUID(), selection });
    await stager.close();

    const recovered = await readFile(
      join(artifactRoot, ".input-resource-staging", selection.staged.stagingId),
    );
    expect(recovered.toString("utf8")).toBe("retained draft bytes\n");
  } finally {
    await stager.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});
