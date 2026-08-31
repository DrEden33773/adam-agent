import { encode as encodeJpeg } from "jpeg-js";
import { expect, test } from "vitest";

import { inspectExplicitUserImageV1, normalizeExplicitUserImageToPngV1 } from "./image-input.js";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("clipboard PNG normalization preserves decoded dimensions and emits valid PNG bytes", () => {
  const normalized = normalizeExplicitUserImageToPngV1(onePixelPng);
  expect([...normalized.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(inspectExplicitUserImageV1(normalized)).toEqual({
    status: "valid",
    mediaType: "image/png",
    width: 1,
    height: 1,
  });
});

test("clipboard JPEG normalization trusts complete decode instead of a MIME claim", () => {
  const jpeg = encodeJpeg({ width: 1, height: 1, data: Buffer.from([255, 0, 0, 255]) }, 90).data;
  const normalized = normalizeExplicitUserImageToPngV1(jpeg);
  expect(inspectExplicitUserImageV1(normalized)).toEqual({
    status: "valid",
    mediaType: "image/png",
    width: 1,
    height: 1,
  });
});

test("clipboard image normalization rejects malformed magic without producing bytes", () => {
  expect(() => normalizeExplicitUserImageToPngV1(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toThrow(
    "not a complete valid PNG or JPEG",
  );
});
