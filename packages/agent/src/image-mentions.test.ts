import { expect, test } from "vitest";
import { findImageMentions } from "./image-mentions.js";

test.each([
  ["Look @a.png, then @b.JPG.", ["a.png", "b.JPG"]],
  ["@\"中文 空格.png\" @'second image.jpeg'", ["中文 空格.png", "second image.jpeg"]],
  ["@/tmp/image.png @~/Pictures/photo.jpg", ["/tmp/image.png", "~/Pictures/photo.jpg"]],
  ["看图：@图.png。", ["图.png"]],
  ["`@code.png` ``@code.jpg`` @real.png", ["real.png"]],
  ["```ts\n@code.png\n```\n@real.png", ["real.png"]],
  ["~~~\n@code.png\n~~~\n@real.png", ["real.png"]],
  ["> ~~~\n> @example.png\n> ~~~\n@real.png", ["real.png"]],
  ["- ~~~\n  @example.png\n  ~~~\n@real.png", ["real.png"]],
  ["`not code `` then @image.png", ["image.png"]],
  ["    @code.png\n@real.png", ["real.png"]],
  ["\\@literal.png mail@example.png @Explore @README.md @icon.svg", []],
  ["@https://example.com/a.png", []],
] as const)("image references in %s", (text, paths) => {
  expect(findImageMentions(text).map((match) => match.path)).toEqual(paths);
});

test("accepted paths inside code stay inert, including names with spaces", () => {
  expect(
    findImageMentions("`@image file.png`", [{ start: 1, end: 16, path: "image file.png" }]),
  ).toEqual([]);
});
