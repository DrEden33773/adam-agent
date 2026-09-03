import { expect, test } from "vitest";
import { AdamAutocompleteProvider } from "./command-autocomplete.js";
import { adamCommandRegistry } from "./command-registry.js";

test("active-run slash completion keeps the complete Registry with availability annotations", async () => {
  const provider = new AdamAutocompleteProvider({
    getProjectPaths: () => [],
    getRunActive: () => true,
    getSkills: () => [],
  });

  const suggestions = await provider.getSuggestions(["/"], 0, 1, {
    signal: new AbortController().signal,
  });
  expect(suggestions?.items).toHaveLength(adamCommandRegistry.entries().length);
  const agents = suggestions?.items.find((item) => item.value === "/agents");
  const name = suggestions?.items.find((item) => item.value === "/name");
  expect(agents?.description).not.toContain("unavailable");
  expect(name?.description).toContain("unavailable · idle only");
  const firstUnavailable = suggestions?.items.findIndex((item) =>
    item.description?.includes("unavailable"),
  );
  expect(firstUnavailable).toBeGreaterThan(0);
  expect(
    suggestions?.items
      .slice(firstUnavailable)
      .every((item) => item.description?.includes("unavailable")),
  ).toBe(true);
});

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
      adamSkill: {
        name: "shared",
        qualifiedId: "skill:v1:project:packages/app:shared",
      },
      value: "$shared",
      label: "$shared",
      description: "project:packages/app · Project procedure.",
    },
    {
      adamSkill: { name: "shared", qualifiedId: "skill:v1:user:shared" },
      value: "$shared",
      label: "$shared",
      description: "user · User procedure.",
    },
    {
      adamSkill: {
        name: "shared",
        qualifiedId: "skill:v1:extension:eve:shared",
      },
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

test("path mention rows separate file names from parent paths without changing identity", async () => {
  const provider = new AdamAutocompleteProvider({
    getProjectPaths: () => ["README.md", "packages/extension-api/README.md"],
    getRunActive: () => false,
    getSkills: () => [],
    path: (value) => `<text>${value}</text>`,
  });

  await expect(
    provider.getSuggestions(["Use @"], 0, 5, {
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual({
    items: [
      {
        adamPath: { path: "README.md" },
        value: "@README.md",
        label: "<text>@README.md</text>",
        description: "./",
      },
      {
        adamPath: { path: "packages/extension-api/README.md" },
        value: "@packages/extension-api/README.md",
        label: "<text>@README.md</text>",
        description: "packages/extension-api/",
      },
    ],
    prefix: "@",
  });
});

test("path mentions recall root and nested files with the same matching name", async () => {
  const provider = new AdamAutocompleteProvider({
    getProjectPaths: () => [
      "AGENTS.md",
      "examples/portfolio-walkthrough/AGENTS.md",
      "src/alpha.ts",
    ],
    getRunActive: () => false,
    getSkills: () => [],
  });
  const input = "Use @agents";

  await expect(
    provider.getSuggestions([input], 0, input.length, {
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual({
    items: [
      {
        adamPath: { path: "AGENTS.md" },
        value: "@AGENTS.md",
        label: "@AGENTS.md",
        description: "./",
      },
      {
        adamPath: { path: "examples/portfolio-walkthrough/AGENTS.md" },
        value: "@examples/portfolio-walkthrough/AGENTS.md",
        label: "@AGENTS.md",
        description: "examples/portfolio-walkthrough/",
      },
    ],
    prefix: "@agents",
  });
});
