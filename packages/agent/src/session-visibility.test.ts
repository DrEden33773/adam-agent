import { expect, test } from "vitest";
import { createSessionVisibilityRepository } from "./session-visibility.js";

const sessionId = "00000000-0000-4000-8000-000000000001";

test.each(["write", "rename", "sync"])(
  "archive %s failure never produces a success receipt",
  async (phase) => {
    let text: string | undefined;
    const repository = createSessionVisibilityRepository({
      workspaceRoot: "/unused-test-project",
      stateRoot: "/unused-test-state",
      storage: {
        async read() {
          return text === undefined ? { status: "missing" } : { status: "available", text };
        },
        async runExclusive(operation) {
          return operation();
        },
        async write(next) {
          // A sync failure can occur after atomic replacement; do not claim rollback.
          if (phase === "sync") text = next;
          throw new Error(`Injected filesystem ${phase} failure`);
        },
      },
    });
    expect(
      await repository.update({ sessionId, visibility: "archived", expectedRevision: 0 }),
    ).toMatchObject({ status: "unavailable" });
    expect(await repository.load()).toMatchObject({
      status: "ready",
      revision: phase === "sync" ? 1 : 0,
      archived: phase === "sync" ? [sessionId] : [],
    });
  },
);

test.each([
  '{"schemaVersion":1,"revision":0,"revision":1,"archived":[]}',
  JSON.stringify({ schemaVersion: 1, revision: 0, archived: [sessionId, sessionId] }),
  JSON.stringify({ schemaVersion: 2, revision: 0, archived: [] }),
])("ambiguous or incompatible archive metadata cannot be overwritten", async (text) => {
  let writes = 0;
  const repository = createSessionVisibilityRepository({
    workspaceRoot: "/unused-test-project",
    stateRoot: "/unused-test-state",
    storage: {
      async read() {
        return { status: "available", text };
      },
      async write() {
        writes += 1;
      },
    },
  });
  expect((await repository.load()).status).toBe("unknown");
  expect(
    (await repository.update({ sessionId, visibility: "archived", expectedRevision: 0 })).status,
  ).toBe("unavailable");
  expect(writes).toBe(0);
});
