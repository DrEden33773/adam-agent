import * as fs from "node:fs/promises";
import { sessionTrashFileSystem } from "@adam-agent/agent/internal-testing";
import {
  createSessionLifecycleForTests,
  modelTargetsWithDriver,
} from "./session-lifecycle.test-support.js";

const [workspaceRoot, stateRoot, action, identity] = process.argv.slice(2);
if (
  workspaceRoot === undefined ||
  stateRoot === undefined ||
  identity === undefined ||
  (action !== "prepare" && action !== "trash" && action !== "restore")
)
  throw new Error("Invalid crash fixture input");
process.on("message", () => {});
let intercepted = false;
const lifecycle = createSessionLifecycleForTests({
  workspaceRoot,
  stateRoot,
  modelTargets: modelTargetsWithDriver({
    stream() {
      throw new Error("Trash recovery must not invoke a model");
    },
  }),
  [sessionTrashFileSystem]: {
    ...fs,
    async rename(source, destination) {
      if (action === "prepare" && String(source).includes(".preparing-") && !intercepted) {
        intercepted = true;
        process.send?.({ type: "prepared" });
        await new Promise<void>(() => {});
      }
      await fs.rename(source, destination);
    },
    async link(source, destination) {
      await fs.link(source, destination);
      if (!intercepted) {
        intercepted = true;
        process.send?.({ type: "linked" });
        await new Promise<void>(() => {});
      }
    },
  },
});
try {
  if (action !== "restore") {
    const preview = await lifecycle.previewSessionTrash({ sessionId: identity });
    if (preview.previewId === null) throw new Error(JSON.stringify(preview.blockers));
    await lifecycle.confirmSessionTrash({ previewId: preview.previewId });
  } else {
    const item = (await lifecycle.listSessionTrash()).items.find(
      (item) => item.transactionId === identity,
    );
    if (item === undefined) throw new Error("Missing retained transaction");
    await lifecycle.restoreSessionTrash({
      transactionId: identity,
      expectedRevision: item.revision,
    });
  }
  process.send?.({ type: "unexpected_completion" });
} catch (error) {
  process.send?.({
    type: "failed",
    message: error instanceof Error ? error.message : String(error),
  });
} finally {
  await lifecycle.close();
  process.disconnect?.();
}
