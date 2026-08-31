import { describe, expect, test } from "vitest";

import { ResponsiveWrappedText } from "./responsive-root.js";

describe("ResponsiveWrappedText", () => {
  test("preserves an exact maximum-name Skill diagnostic at minimum width", () => {
    const diagnostic = `Skill $${"a".repeat(64)} is unavailable; delete it or choose a current Skill.`;

    const lines = new ResponsiveWrappedText(diagnostic).render(40);

    expect(lines.join("").replace(/\s+/gu, "")).toBe(diagnostic.replace(/\s+/gu, ""));
    expect(lines.every((line) => line.length <= 40)).toBe(true);
  });
});
