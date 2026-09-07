import { createManagedReviewHarness } from "./managed-review-test-support.js";

const { ADAM_REVIEW_FIXTURE_ROOT: durableRoot, ADAM_REVIEW_FIXTURE_PHASE: phase } = process.env;
if (durableRoot === undefined || phase === undefined)
  throw new Error("Missing review fixture configuration.");
const started = Promise.withResolvers<string>();
process.on("message", () => {});
const barrier = async () => {
  process.send?.({ phase, operationId: await started.promise });
  await new Promise<never>(() => {});
};
const harness = await createManagedReviewHarness({
  durableRoot,
  ...(phase === "invoked" ? { beforeResolveOrigin: barrier } : {}),
  model: {
    async *stream() {
      await barrier();
      yield { type: "finish", reason: "stop" };
    },
  },
});
const operation = await harness.start();
started.resolve(operation.operationId);
await harness.events(operation.operationId);
