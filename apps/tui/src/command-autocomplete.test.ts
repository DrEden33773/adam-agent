import { SelectList } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { AdamAutocompleteProvider } from "./command-autocomplete.js";
import { adamCommandRegistry } from "./command-registry.js";

test("role completion renders untrusted descriptions as inert terminal text", async () => {
  const provider = new AdamAutocompleteProvider({
    getProjectPaths: () => [],
    getRunActive: () => false,
    getSkills: () => [],
    getRoles: () => [
      {
        qualifiedId: "user:Audit",
        name: "Audit",
        description: "\x1b[2JFORGED",
        base: "explore",
        tools: [],
        web: false,
        definitionDigest: `sha256:${"0".repeat(64)}`,
      },
    ],
  });
  const suggestions = await provider.getSuggestions(["@"], 0, 1, {
    signal: new AbortController().signal,
  });
  const list = new SelectList(
    [
      { value: "@Explore", label: "@Explore", description: "Safe built-in" },
      ...(suggestions?.items ?? []),
    ],
    8,
    {
      selectedPrefix: (s) => s,
      selectedText: (s) => s,
      description: (s) => s,
      scrollInfo: (s) => s,
      noMatch: (s) => s,
    },
    { overrideSelectedStyles: true },
  );
  const rendered = list.render(120).join("\n");
  expect(rendered).toContain("FORGED");
  expect(rendered).not.toContain("\x1b[2J");
});

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
      label: "shared",
      description: "project:packages/app · Project procedure.",
    },
    {
      adamSkill: { name: "shared", qualifiedId: "skill:v1:user:shared" },
      value: "$shared",
      label: "shared",
      description: "user · User procedure.",
    },
    {
      adamSkill: {
        name: "shared",
        qualifiedId: "skill:v1:extension:eve:shared",
      },
      value: "$shared",
      label: "shared",
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
        label: "<text>README.md</text>",
        description: "[File] README.md",
      },
      {
        adamPath: { path: "packages/extension-api/README.md" },
        value: "@packages/extension-api/README.md",
        label: "<text>README.md</text>",
        description: "[File] packages/extension-api/README.md",
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
        label: "AGENTS.md",
        description: "[File] AGENTS.md",
      },
      {
        adamPath: { path: "examples/portfolio-walkthrough/AGENTS.md" },
        value: "@examples/portfolio-walkthrough/AGENTS.md",
        label: "AGENTS.md",
        description: "[File] examples/portfolio-walkthrough/AGENTS.md",
      },
    ],
    prefix: "@agents",
  });
});

test("command arguments own their completion and never fall back to project files", async () => {
  const provider = new AdamAutocompleteProvider({
    getProjectPaths: () => ["README.md", "src/"],
    getRunActive: () => false,
    getSkills: () => [],
  });
  for (const [input, expected] of [
    ["/agents ", ["history", "settings", "attention"]],
    ["/agents s", ["settings"]],
    ["/copy ", ["draft"]],
  ] as const) {
    for (const force of [false, true]) {
      const result = await provider.getSuggestions([input], 0, input.length, {
        force,
        signal: new AbortController().signal,
      });
      expect(result?.items.map((item) => item.value)).toEqual(expected);
      expect(result?.items.every((item) => Boolean(item.description))).toBe(true);
      const item = result?.items[0];
      if (item && result)
        expect(
          provider.applyCompletion([input], 0, input.length, item, result.prefix).lines,
        ).toEqual([`${input.split(" ")[0]} ${expected[0]}`]);
    }
  }
  for (const input of [
    "/agents wrong",
    "/copy src",
    "/exit ",
    "/detach ",
    "/cancelattach ",
    "/skills wrong",
    "/config web https://",
  ]) {
    expect(
      await provider.getSuggestions([input], 0, input.length, {
        force: true,
        signal: new AbortController().signal,
      }),
    ).toBeNull();
  }
});

test("dynamic argument catalogs preserve resource indexes and available thinking and Skill values", async () => {
  let resources = [
    { index: 2, label: "log.txt", status: "ready" },
    { index: 4, label: "image.png", status: "copying" },
  ];
  const provider = new AdamAutocompleteProvider({
    getProjectPaths: () => ["src/main.ts"],
    getRunActive: () => false,
    getResources: () => resources,
    getThinkingLevelIds: () => ["medium", "high"],
    getSkills: () => [
      {
        name: "audit",
        qualifiedId: "skill:v1:user:audit",
        description: "Audit changes",
        source: { type: "user" },
      },
    ],
  });
  const suggest = (input: string) =>
    provider.getSuggestions([input], 0, input.length, {
      force: true,
      signal: new AbortController().signal,
    });
  expect((await suggest("/detach "))?.items).toEqual([
    { label: "2", value: "2", description: "log.txt · ready" },
    { label: "4", value: "4", description: "image.png · copying" },
  ]);
  expect((await suggest("/cancelattach "))?.items.map((item) => item.value)).toEqual(["4"]);
  resources = [];
  expect(await suggest("/detach ")).toBeNull();
  expect((await suggest("/thinking "))?.items.map((item) => item.value)).toEqual([
    "medium",
    "high",
  ]);
  expect((await suggest("/skills skill:"))?.items).toEqual([
    { label: "skill:v1:user:audit", value: "skill:v1:user:audit", description: "Audit changes" },
  ]);
  expect((await suggest("/attach src/"))?.items.map((item) => item.value)).toEqual(["src/main.ts"]);
  for (const input of [
    "/help ",
    "/config ",
    "/config context ",
    "/config web ",
    "/instructions ",
    "/skills ",
    "/name ",
    "/trust ",
    "/todos ",
    "/thinking ",
  ]) {
    const items = (await suggest(input))?.items;
    expect(items?.length).toBeGreaterThan(0);
    expect(items?.every((item) => Boolean(item.description))).toBe(true);
  }
});

test("attach completes literal paths beginning with mention characters without binding atoms", async () => {
  const provider = new AdamAutocompleteProvider({
    getProjectPaths: () => ["@audit.txt", "$audit.txt", "audit.txt"],
    getRunActive: () => false,
    getRoles: () => [
      {
        name: "audit",
        qualifiedId: "user:audit",
        description: "Agent decoy",
        base: "explore",
        tools: [],
        web: false,
        definitionDigest: `sha256:${"0".repeat(64)}`,
      },
    ],
    getSkills: () => [
      {
        name: "audit",
        qualifiedId: "skill:v1:user:audit",
        description: "Skill decoy",
        source: { type: "user" },
      },
    ],
  });
  for (const prefix of ["@a", "$a"]) {
    for (const force of [false, true]) {
      const input = `/attach ${prefix}`;
      const result = await provider.getSuggestions([input], 0, input.length, {
        force,
        signal: new AbortController().signal,
      });
      const path = `${prefix[0]}audit.txt`;
      expect(result).toEqual({ items: [{ label: path, value: path }], prefix });
      const item = result?.items[0];
      if (result && item)
        expect(
          provider.applyCompletion([input], 0, input.length, item, result.prefix).lines,
        ).toEqual([`/attach ${path}`]);
    }
  }
});
