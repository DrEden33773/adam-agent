import { expect, test } from "vitest";
import {
  adamCommandRegistry,
  createAdamCommandRegistryFromContributions,
} from "./command-registry.js";

test("the TUI Registry hides attachment actions for a historical text-only session", () => {
  const attachmentCommands = adamCommandRegistry
    .entries()
    .filter(
      (command) =>
        command.id === "attach" || command.id === "detach" || command.id === "cancelattach",
    );

  expect(attachmentCommands).toHaveLength(3);
  expect(
    attachmentCommands.every(
      (command) =>
        !adamCommandRegistry.isAvailable(command, {
          attachmentsAvailable: false,
          runActive: false,
        }),
    ),
  ).toBe(true);
});

test("the TUI Registry exposes the read-only Todo navigator", () => {
  expect(adamCommandRegistry.parse("/todos")).toMatchObject({
    kind: "known",
    argumentsText: "",
    command: {
      id: "todos",
      usage: "/todos",
      summary: "Browse the authoritative Todo store without mutation.",
    },
  });
});

test("the TUI Registry parses the explicit clipboard image action", () => {
  expect(adamCommandRegistry.parse("/paste-image")).toMatchObject({
    kind: "known",
    argumentsText: "",
    command: {
      id: "paste-image",
      usage: "/paste-image",
    },
  });
});

test("the TUI Registry exposes only descriptor commands backed by project changes", () => {
  const registry = createAdamCommandRegistryFromContributions([
    {
      command: { id: "fixture.command-only", name: "orphan", title: "Orphan command", version: 1 },
    },
    {
      command: { id: "fixture.wrong-input", name: "wrong", title: "Wrong input", version: 1 },
      inputSource: { id: "remote_pull_request", version: 1 },
    },
    {
      command: { id: "fixture.wrong-version", name: "old", title: "Old input", version: 1 },
      inputSource: { id: "project_changes", version: 2 },
    },
    {
      command: { id: "fixture.review", name: "review", title: "Review changes", version: 1 },
      inputSource: { id: "project_changes", version: 1 },
    },
  ]);

  expect(registry.entries().filter((entry) => entry.id === "extension")).toMatchObject([
    { name: "review", usage: "/review" },
  ]);
});
