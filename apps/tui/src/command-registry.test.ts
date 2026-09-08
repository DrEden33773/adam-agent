import { expect, test } from "vitest";
import {
  adamCommandRegistry,
  createAdamCommandRegistry,
  createAdamCommandRegistryFromContributions,
} from "./command-registry.js";

test("Todo overlay uses one configurable semantic binding and exposes its effective Help key", () => {
  expect(adamCommandRegistry.keybinding("toggle_todo_overlay")).toMatchObject({
    inputs: ["alt+t"],
    keys: "Alt+T",
  });
  expect(adamCommandRegistry.matchesInput("\u001bt", "toggle_todo_overlay")).toBe(true);
  const configured = createAdamCommandRegistry([], { todoToggleKey: "ctrl+shift+t" });
  expect(configured.keybinding("toggle_todo_overlay")).toMatchObject({ keys: "Ctrl+Shift+T" });
  expect(configured.matchesInput("\u001b[116;6u", "toggle_todo_overlay")).toBe(true);
  expect(configured.matchesInput("\u001bt", "toggle_todo_overlay")).toBe(false);
  expect(configured.matchesInput("\u0014", "toggle_todo_overlay")).toBe(false);
});

test("Plan Registry copy stays policy-neutral", () => {
  const parsed = adamCommandRegistry.parse("/plan");
  expect(parsed).toMatchObject({
    kind: "known",
    command: {
      summary: "Enter or exit the authoritative Plan cycle.",
    },
  });
});

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

test("the TUI Registry exposes the active-run read-only Todo navigator", () => {
  expect(adamCommandRegistry.parse("/todos")).toMatchObject({
    kind: "known",
    argumentsText: "",
    command: {
      id: "todos",
      availability: "always",
      usage: "/todos [toggle]",
      summary: "Browse the authoritative Todo store without mutation.",
    },
  });
});

test("the TUI Registry exposes the active-run managed-child navigator", () => {
  const parsed = adamCommandRegistry.parse("/agents");
  expect(parsed).toMatchObject({
    kind: "known",
    command: {
      id: "agents",
      availability: "always",
      usage: "/agents [history|settings|attention]",
    },
  });
});

test("the TUI Registry has no application-owned clipboard read actions", () => {
  expect(adamCommandRegistry.parse("/paste")).toMatchObject({ kind: "unknown", name: "paste" });
  expect(adamCommandRegistry.parse("/paste-image")).toMatchObject({
    kind: "unknown",
    name: "paste-image",
  });
  expect(adamCommandRegistry.keybindings().map((binding) => binding.keys)).not.toContain("Alt+V");
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
