import { expect, test } from "vitest";
import { AdamAutocompleteProvider } from "./command-autocomplete.js";

test("Skill mention rows expose deterministic source labels without qualified IDs", async () => {
  const provider = new AdamAutocompleteProvider({
    getProjectPaths: () => [],
    getRunActive: () => false,
    getSkills: () => [
      {
        description: "Project procedure.",
        name: "shared",
        qualifiedId: "skill:v1:project:packages/app:shared",
        source: { type: "project", scope: "packages/app" },
      },
      {
        description: "User procedure.",
        name: "shared",
        qualifiedId: "skill:v1:user:shared",
        source: { type: "user" },
      },
      {
        description: "Extension procedure.",
        name: "shared",
        qualifiedId: "skill:v1:extension:eve:shared",
        source: { type: "extension", extensionId: "eve", packageVersion: "0.3.0" },
      },
    ],
  });

  const suggestions = await provider.getSuggestions(["Use $sha"], 0, 8, {
    signal: new AbortController().signal,
  });
  expect(suggestions?.items).toEqual([
    {
      value: "$shared",
      label: "$shared",
      description: "project:packages/app · Project procedure.",
    },
    { value: "$shared", label: "$shared", description: "user · User procedure." },
    {
      value: "$shared",
      label: "$shared",
      description: "extension:eve@0.3.0 · Extension procedure.",
    },
  ]);
});

test("forced project-path rows use the caller's Text semantic slot", async () => {
  const provider = new AdamAutocompleteProvider({
    getProjectPaths: () => ["src/alpha.ts"],
    getRunActive: () => false,
    getSkills: () => [],
    path: (value) => `<text>${value}</text>`,
  });

  await expect(
    provider.getSuggestions(["src/a"], 0, 5, {
      force: true,
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual({
    items: [{ value: "src/alpha.ts", label: "<text>src/alpha.ts</text>" }],
    prefix: "src/a",
  });
});
