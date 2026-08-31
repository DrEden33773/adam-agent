import { expect, test } from "vitest";
import { AdamAutocompleteProvider } from "./command-autocomplete.js";
import { adamStructuredEditorCompletion } from "./structured-editor-completion.js";

const provider = new AdamAutocompleteProvider({
  getProjectPaths: () => [],
  getRunActive: () => false,
  getSkills: () => [],
});

test("structured completion hides atom labels while preserving earlier literal slash eligibility", async () => {
  const cursor = { partId: "right", offset: 3 } as const;
  const afterAtom = [
    { type: "atom", id: "resource", label: "[Text #1]" },
    { type: "text", id: "right", text: "/pl" },
  ] as const;
  const eligible = adamStructuredEditorCompletion.project(afterAtom, cursor);
  expect(eligible).not.toBeNull();
  await expect(
    provider.getSuggestions(
      [...(eligible?.lines ?? [])],
      eligible?.cursorLine ?? 0,
      eligible?.cursorCol ?? 0,
      { signal: new AbortController().signal },
    ),
  ).resolves.toMatchObject({
    items: expect.arrayContaining([expect.objectContaining({ value: "/plan" })]),
  });

  const afterEarlierLiteral = [
    { type: "text", id: "left", text: "explain" },
    ...afterAtom,
  ] as const;
  const blocked = adamStructuredEditorCompletion.project(afterEarlierLiteral, cursor);
  expect(blocked).not.toBeNull();
  await expect(
    provider.getSuggestions(
      [...(blocked?.lines ?? [])],
      blocked?.cursorLine ?? 0,
      blocked?.cursorCol ?? 0,
      { signal: new AbortController().signal },
    ),
  ).resolves.toBeNull();
});

test("structured completion acceptance preserves every atom identity and order", () => {
  const document = [
    { type: "atom", id: "resource", label: "[Text #1]" },
    { type: "text", id: "right", text: "Use $fir" },
  ] as const;

  expect(
    adamStructuredEditorCompletion.accept(
      document,
      { partId: "right", offset: 8 },
      { label: "$first", value: "$first" },
      "$fir",
    ),
  ).toEqual({
    cursor: { partId: "right", offset: 10 },
    document: [
      { type: "atom", id: "resource", label: "[Text #1]" },
      { type: "text", id: "right", text: "Use $first" },
    ],
    range: {
      anchor: { partId: "right", offset: 4 },
      focus: { partId: "right", offset: 8 },
    },
    text: "$first",
  });
});

test("structured insertion creates one text part at an exact captured atom edge", () => {
  expect(
    adamStructuredEditorCompletion.accept(
      [{ type: "atom", id: "resource", label: "[Text #1]" }],
      { partId: "resource", edge: "after" },
      { label: "clip", value: "clip" },
      "",
    ),
  ).toEqual({
    cursor: { partId: "adam-editor-text-1", offset: 4 },
    document: [
      { type: "atom", id: "resource", label: "[Text #1]" },
      { type: "text", id: "adam-editor-text-1", text: "clip" },
    ],
    range: {
      anchor: { partId: "resource", edge: "after" },
      focus: { partId: "resource", edge: "after" },
    },
    text: "clip",
  });
});
