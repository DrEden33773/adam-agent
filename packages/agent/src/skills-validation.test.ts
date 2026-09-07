import { expect, test } from "vitest";
import { createEmptySkillContextV1, isSkillContextRecordV1Valid } from "./skills.js";

test("a frozen Skill accessor does not reuse validation after its value changes", () => {
  const context = createEmptySkillContextV1({
    effectiveContextTokens: 128_000,
    estimatorVersion: 1,
  });
  let revision = context.registry.revision;
  Object.defineProperty(context.registry, "revision", { get: () => revision, enumerable: true });
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(context);
  expect(isSkillContextRecordV1Valid(context)).toBe(true);
  revision = -1;
  expect(isSkillContextRecordV1Valid(context)).toBe(false);
});
