import { randomUUID } from "node:crypto";
import type { TurnComposerResourceStager } from "./input-resource-staging.js";
import {
  type InputResourceOccurrenceV1,
  inputResourceLimitsV1,
  type StagedInputResourceSelectionV1,
  safeInputResourceDisplayNameV1,
} from "./input-resources.js";

export {
  type TurnComposerStageBarrier,
  turnComposerStageBarrier,
} from "./input-resource-staging.js";

export type TurnComposerResourceSnapshot = {
  readonly id: string;
  readonly displayName: string;
  readonly state: "queued" | "copying" | "ready" | "failed" | "cancelled" | "removed";
  readonly byteCount: number | null;
  readonly support: InputResourceOccurrenceV1["support"] | null;
  readonly diagnostic: string | null;
};

type TurnComposerResource = {
  readonly id: string;
  displayName: string;
  state: TurnComposerResourceSnapshot["state"];
  byteCount: number | null;
  support: InputResourceOccurrenceV1["support"] | null;
  diagnostic: string | null;
  readonly controller: AbortController;
  staged: StagedInputResourceSelectionV1 | null;
  settlement: Promise<void> | null;
};

export class TurnComposerError extends Error {
  readonly code: "cancelled" | "failed" | "limit_exceeded" | "unsupported";

  constructor(code: TurnComposerError["code"], message: string) {
    super(message);
    this.name = "TurnComposerError";
    this.code = code;
  }
}

export type TurnComposer = {
  stage(path: string): Promise<string>;
  cancel(id: string): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  setText(text: string): void;
  seal(signal: AbortSignal): Promise<{
    readonly text: string;
    readonly selections: readonly StagedInputResourceSelectionV1[];
  }>;
  unseal(): void;
  clear(): Promise<void>;
  close(): Promise<void>;
  snapshot(): {
    readonly sealed: boolean;
    readonly resources: readonly TurnComposerResourceSnapshot[];
  };
};

export async function createTurnComposer(options: {
  readonly onChange: () => void;
  readonly stager: TurnComposerResourceStager;
}): Promise<TurnComposer> {
  const resources = new Map<string, TurnComposerResource>();
  let text = "";
  let sealed = false;
  let closed = false;

  const publish = (): void => {
    if (!closed) {
      options.onChange();
    }
  };

  const discardStaging = async (resource: TurnComposerResource): Promise<void> => {
    if (resource.staged !== null) {
      const staged = resource.staged;
      resource.staged = null;
      await options.stager.discard(staged);
    }
  };

  return {
    async cancel(id) {
      if (closed || sealed) {
        return false;
      }
      const resource = resources.get(id);
      if (
        resource === undefined ||
        resource.state === "cancelled" ||
        resource.state === "removed"
      ) {
        return false;
      }
      resource.state = "cancelled";
      resource.diagnostic = null;
      resource.controller.abort();
      publish();
      await resource.settlement;
      await discardStaging(resource);
      return true;
    },
    async remove(id) {
      if (closed || sealed) {
        return false;
      }
      const resource = resources.get(id);
      if (resource === undefined) {
        return false;
      }
      resource.state = "removed";
      resource.controller.abort();
      publish();
      await resource.settlement;
      await discardStaging(resource);
      resources.delete(id);
      publish();
      return true;
    },
    async stage(path) {
      if (closed || sealed) {
        throw new TypeError("The turn composer is not accepting input resources.");
      }
      const retainedCount = [...resources.values()].filter(
        (resource) => resource.state !== "cancelled" && resource.state !== "removed",
      ).length;
      if (retainedCount >= inputResourceLimitsV1.maximumOccurrencesPerRun) {
        throw new TypeError("The turn composer input-resource count exceeds the v1 run limit.");
      }
      const id = randomUUID();
      const resource: TurnComposerResource = {
        id,
        displayName: safeInputResourceDisplayNameV1(path),
        state: "queued",
        byteCount: null,
        support: null,
        diagnostic: null,
        controller: new AbortController(),
        staged: null,
        settlement: null,
      };
      resources.set(id, resource);
      publish();
      resource.state = "copying";
      publish();
      const settlement = (async () => {
        try {
          const staged = await options.stager.stage({
            id,
            path,
            signal: resource.controller.signal,
          });
          if (closed || resource.state === "cancelled" || !resources.has(id)) {
            await options.stager.discard(staged);
            return;
          }
          resource.displayName = staged.displayName;
          resource.byteCount = staged.staged.byteCount;
          resource.support = staged.support;
          resource.staged = staged;
          resource.state = "ready";
          publish();
        } catch (error) {
          if (resource.state === "cancelled" || closed || !resources.has(id)) {
            return;
          }
          resource.state = "failed";
          resource.diagnostic =
            error instanceof Error ? error.message : "The selected input resource failed.";
          publish();
        }
      })();
      resource.settlement = settlement;
      await settlement;
      return id;
    },
    async seal(signal) {
      if (closed || sealed) {
        throw new TurnComposerError("failed", "The turn composer cannot be sealed.");
      }
      sealed = true;
      publish();
      const cancelStaging = (): void => {
        for (const resource of resources.values()) {
          if (resource.state === "queued" || resource.state === "copying") {
            resource.state = "cancelled";
            resource.diagnostic = null;
            resource.controller.abort();
          }
        }
        publish();
      };
      signal.addEventListener("abort", cancelStaging, { once: true });
      try {
        await Promise.all([...resources.values()].map((resource) => resource.settlement));
      } finally {
        signal.removeEventListener("abort", cancelStaging);
      }
      if (signal.aborted) {
        sealed = false;
        publish();
        throw new TurnComposerError("cancelled", "Input-resource sealing was cancelled.");
      }
      const retained = [...resources.values()].filter(
        (resource) => resource.state !== "cancelled" && resource.state !== "removed",
      );
      const failed = retained.find((resource) => resource.state !== "ready");
      if (failed !== undefined) {
        sealed = false;
        publish();
        throw new TurnComposerError(
          "failed",
          "Every retained input resource must be ready before send.",
        );
      }
      const aggregateBytes = retained.reduce(
        (total, resource) => total + (resource.byteCount ?? 0),
        0,
      );
      if (aggregateBytes > inputResourceLimitsV1.maximumAggregateBytesPerRun) {
        sealed = false;
        publish();
        throw new TurnComposerError(
          "limit_exceeded",
          "The retained input resources exceed the v1 aggregate run limit.",
        );
      }
      if (retained.some((resource) => resource.support !== "utf8_text")) {
        sealed = false;
        publish();
        throw new TurnComposerError(
          "unsupported",
          "Every retained input resource must have supported immutable content.",
        );
      }
      return {
        text,
        selections: retained.map((resource) => resource.staged as StagedInputResourceSelectionV1),
      };
    },
    async clear() {
      const retained = [...resources.values()];
      sealed = false;
      for (const resource of retained) {
        if (resource.state === "queued" || resource.state === "copying") {
          resource.state = "cancelled";
          resource.diagnostic = null;
          resource.controller.abort();
        }
      }
      await Promise.allSettled(retained.map((resource) => resource.settlement));
      resources.clear();
      await Promise.all(retained.map(discardStaging));
      text = "";
      publish();
    },
    setText(nextText) {
      if (closed || sealed) {
        throw new TypeError("The sealed turn composer cannot change draft text.");
      }
      if (text !== nextText) {
        text = nextText;
        publish();
      }
    },
    unseal() {
      if (!closed && sealed) {
        sealed = false;
        publish();
      }
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      for (const resource of resources.values()) {
        resource.controller.abort();
      }
      await Promise.allSettled([...resources.values()].map((resource) => resource.settlement));
      await options.stager.close();
      resources.clear();
    },
    snapshot() {
      return {
        sealed,
        resources: [...resources.values()].map(
          ({ controller: _controller, settlement: _settlement, staged: _staged, ...item }) => item,
        ),
      };
    },
  };
}
