import { expect, test } from "vitest";

import {
  isLargePastedTextV1,
  isPastedTextOrphanCleanupEligibleV1,
  normalizePastedTextV1,
  pastedTextMetricsV1,
  pastedTextOrphanRetentionMillisecondsV1,
} from "./pasted-text.js";

test("pasted-text promotion uses normalized logical-line boundaries", () => {
  const tenLines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
  const elevenLines = `${tenLines}\nline 11`;

  expect(pastedTextMetricsV1(tenLines).lineCount).toBe(10);
  expect(isLargePastedTextV1(tenLines)).toBe(false);
  expect(pastedTextMetricsV1(elevenLines).lineCount).toBe(11);
  expect(isLargePastedTextV1(elevenLines)).toBe(true);
});

test("pasted-text normalization freezes CRLF, CR, and tab handling", () => {
  expect(normalizePastedTextV1("first\r\nsecond\rthird\tfourth")).toBe(
    "first\nsecond\nthird    fourth",
  );
});

test("pasted-text orphan cleanup requires seven days and no canonical draft reference", () => {
  const now = 1_000_000_000;
  expect(
    isPastedTextOrphanCleanupEligibleV1({
      referenced: true,
      modifiedAtMilliseconds: now - pastedTextOrphanRetentionMillisecondsV1,
      nowMilliseconds: now,
    }),
  ).toBe(false);
  expect(
    isPastedTextOrphanCleanupEligibleV1({
      referenced: false,
      modifiedAtMilliseconds: now - pastedTextOrphanRetentionMillisecondsV1 + 1,
      nowMilliseconds: now,
    }),
  ).toBe(false);
  expect(
    isPastedTextOrphanCleanupEligibleV1({
      referenced: false,
      modifiedAtMilliseconds: now - pastedTextOrphanRetentionMillisecondsV1,
      nowMilliseconds: now,
    }),
  ).toBe(true);
});

test("pasted-text promotion counts Unicode scalars instead of UTF-16 units or graphemes", () => {
  const oneThousandScalars = `${"界".repeat(996)}e\u0301👩💻`;
  const oneThousandOneScalars = `${oneThousandScalars}a`;

  expect(Array.from(oneThousandScalars)).toHaveLength(1_000);
  expect(oneThousandScalars.length).toBeGreaterThan(1_000);
  expect(isLargePastedTextV1(oneThousandScalars)).toBe(false);
  expect(Array.from(oneThousandOneScalars)).toHaveLength(1_001);
  expect(isLargePastedTextV1(oneThousandOneScalars)).toBe(true);
});
