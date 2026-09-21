import { expect, test } from "vitest";
import {
  assemblePromptMessagesV1,
  createPromptContextV1,
  createPromptContextV3,
  createRepositoryInstructionRevisionV1,
  isPromptContextCompatible,
  isPromptContextRecordCompatible,
  isPromptContextRecordValid,
  promptContextRecordV3Schema,
  promptContextSnapshot,
  replacePromptRepositoryV1,
  replacePromptSkillsV2,
} from "./prompt-assembly.js";
import legacyBaseV1 from "./prompt-base-v1.fixture.js";
import legacyBaseV2 from "./prompt-base-v2.fixture.js";
import { createEmptySkillContextV1 } from "./skills.js";
import { createInternalToolRegistry } from "./tool-runtime.js";

const tools = createInternalToolRegistry([]);
const skills = createEmptySkillContextV1({
  effectiveContextTokens: 1_000_000,
  estimatorVersion: 1,
});

test("new current prompt contexts record the ambiguity decision procedure", () => {
  const current = createPromptContextV3(tools, createPromptContextV1(tools).repository, skills);
  expect(current.base.version).toBe(3);
  expect(current.base.content).not.toBe(legacyBaseV2.base.content);
  expect(current.base.content.startsWith(`${legacyBaseV2.base.content}\n\n`)).toBe(true);
  const reopened = promptContextRecordV3Schema.parse(JSON.parse(JSON.stringify(current)));
  expect(isPromptContextRecordValid(reopened)).toBe(true);
  expect(isPromptContextRecordCompatible(reopened, tools)).toBe(true);
  expect(isPromptContextCompatible(promptContextSnapshot(reopened), tools)).toBe(true);
  expect(assemblePromptMessagesV1([], reopened)[0]).toEqual({
    role: "system",
    content: current.base.content,
  });
});

test("the ambiguity procedure names every commitment it must carry", () => {
  const current = createPromptContextV3(tools, createPromptContextV1(tools).repository, skills);
  for (const commitment of [
    "at least two candidate readings",
    "evidence from the repository itself",
    "nearest sibling APIs",
    "unverified hypothesis",
    "abandoned alternative",
  ]) {
    expect(current.base.content).toContain(commitment);
  }
});

test("recorded base-v1 contexts retain their bytes through decoding and context refresh", () => {
  // Fixed empty-tool context captured from the previous base-v1 implementation.
  const legacy = promptContextRecordV3Schema.parse(legacyBaseV1);
  expect(isPromptContextRecordValid(legacy)).toBe(true);
  expect(isPromptContextRecordCompatible(legacy, tools)).toBe(true);
  expect(isPromptContextCompatible(promptContextSnapshot(legacy), tools)).toBe(true);
  const refreshed = replacePromptSkillsV2(
    replacePromptRepositoryV1(
      legacy,
      createRepositoryInstructionRevisionV1({
        revision: 2,
        activeScopes: ["."],
        sources: [],
        diagnostics: [],
      }),
    ) as typeof legacy,
    skills,
  );
  expect(refreshed.base).toEqual(legacyBaseV1.base);
  expect(isPromptContextRecordValid(refreshed)).toBe(true);
  expect(assemblePromptMessagesV1([], refreshed)[0]).toEqual({
    role: "system",
    content: legacyBaseV1.base.content,
  });
});

test("recorded base-v2 contexts retain their bytes through decoding and context refresh", () => {
  // Fixed empty-tool context captured from the base-v2 implementation that shipped first.
  const legacy = promptContextRecordV3Schema.parse(legacyBaseV2);
  expect(isPromptContextRecordValid(legacy)).toBe(true);
  expect(isPromptContextRecordCompatible(legacy, tools)).toBe(true);
  expect(isPromptContextCompatible(promptContextSnapshot(legacy), tools)).toBe(true);
  const refreshed = replacePromptSkillsV2(
    replacePromptRepositoryV1(
      legacy,
      createRepositoryInstructionRevisionV1({
        revision: 2,
        activeScopes: ["."],
        sources: [],
        diagnostics: [],
      }),
    ) as typeof legacy,
    skills,
  );
  expect(refreshed.base).toEqual(legacyBaseV2.base);
  expect(isPromptContextRecordValid(refreshed)).toBe(true);
  expect(assemblePromptMessagesV1([], refreshed)[0]).toEqual({
    role: "system",
    content: legacyBaseV2.base.content,
  });
});

test("unknown or mismatched base policies remain inadmissible", () => {
  const current = createPromptContextV3(tools, createPromptContextV1(tools).repository, skills);
  expect(
    promptContextRecordV3Schema.safeParse({ ...current, base: { ...current.base, version: 99 } })
      .success,
  ).toBe(false);
  expect(
    isPromptContextRecordValid({
      ...current,
      base: { ...current.base, content: legacyBaseV1.base.content },
    }),
  ).toBe(false);
  // The same content under the wrong version stays inadmissible as well.
  expect(isPromptContextRecordValid({ ...current, base: { ...current.base, version: 2 } })).toBe(
    false,
  );
});
