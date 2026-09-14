import {
  type ContextProfile,
  createModelTargets,
  type ModelTargetIdentity,
  type ModelTargets,
  type ModelTargetsOptions,
} from "@adam-agent/agent";
import { createDemoModel } from "./demo-model.js";

const fakeTargetIdentity: ModelTargetIdentity = {
  targetId: "fake.local",
  vendor: "adam",
  modelId: "fake-local",
  route: "direct",
  profileVersion: 1,
  certification: "certified",
};
const fakeContextProfile: ContextProfile = {
  version: 1,
  contextWindowTokens: 32_768,
  maximumOutputTokens: 4_096,
  compactAtTokens: 24_576,
  postCompactTargetTokens: 8_192,
  retainedTargetTokens: 4_096,
  estimatorVersion: 1,
};
const fakeModel = createDemoModel();

export function createCliModelTargets(options: ModelTargetsOptions): ModelTargets {
  const configured = createModelTargets(options);
  return {
    async resolve(input) {
      if (input.targetId === fakeTargetIdentity.targetId) {
        return {
          identity: fakeTargetIdentity,
          driver: fakeModel,
          contextProfile: fakeContextProfile,
        };
      }
      return configured.resolve(input);
    },
    async snapshot(input) {
      const snapshot = await configured.snapshot(input);
      return {
        targets: [
          ...snapshot.targets,
          {
            identity: fakeTargetIdentity,
            readiness: { status: "available", credentialSource: "built-in test fixture" },
            contextProfile: fakeContextProfile,
          },
        ],
      };
    },
  };
}
