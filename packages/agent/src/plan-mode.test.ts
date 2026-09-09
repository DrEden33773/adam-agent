import { expect, test } from "vitest";
import {
  createPlanToolProfileV1,
  isPlanToolProfileV1Valid,
  type PlanEligibleToolProfileV1,
  type PlanPolicyVersion,
} from "./plan-mode.js";

const sourceDigest = `sha256:${"a".repeat(64)}` as const;
const definitionDigest = `sha256:${"b".repeat(64)}` as const;

function accepts(
  policy: PlanPolicyVersion,
  definition: Pick<PlanEligibleToolProfileV1["definitions"][number], "name" | "effect" | "source">,
): boolean {
  const profile = createPlanToolProfileV1({
    source: { version: 1, digest: sourceDigest },
    definitions: [
      {
        ...definition,
        definitionDigest,
        ...(definition.source === "mcp"
          ? {
              mcp: {
                serverId: "test-server",
                originalName: definition.name,
                serverDefinitionDigest: sourceDigest,
              },
            }
          : {}),
      },
    ],
  });
  return isPlanToolProfileV1Valid(profile, policy);
}

test("historical Plan policies retain their Todo write denial", () => {
  const historical: readonly PlanPolicyVersion[] = [
    "plan-policy.read-v1",
    "plan-policy.hybrid-v1",
    "plan-policy.hybrid-delegation-v1",
  ];
  for (const policy of historical) {
    for (const name of ["create_todo", "update_todo", "update_todos"]) {
      expect(accepts(policy, { name, effect: "write", source: "builtin" })).toBe(false);
    }
    expect(accepts(policy, { name: "read_file", effect: "read", source: "builtin" })).toBe(true);
  }
});

test("Todo Plan successors admit only the three builtin bookkeeping writes", () => {
  const successors: readonly PlanPolicyVersion[] = [
    "plan-policy.hybrid-todo-v1",
    "plan-policy.hybrid-delegation-todo-v1",
  ];
  for (const policy of successors) {
    for (const name of ["create_todo", "update_todo", "update_todos"]) {
      expect(accepts(policy, { name, effect: "write", source: "builtin" })).toBe(true);
      expect(accepts(policy, { name, effect: "write", source: "mcp" })).toBe(false);
      expect(accepts(policy, { name, effect: "administrative", source: "builtin" })).toBe(false);
    }
    for (const name of ["write_file", "edit_file", "delete_todo", "clear_todos"]) {
      expect(accepts(policy, { name, effect: "write", source: "builtin" })).toBe(false);
    }
    expect(accepts(policy, { name: "run_shell", effect: "execute", source: "builtin" })).toBe(true);
    expect(accepts(policy, { name: "other_shell", effect: "execute", source: "builtin" })).toBe(
      false,
    );
    expect(accepts(policy, { name: "remote_call", effect: "network", source: "mcp" })).toBe(true);
  }
});

test("Todo successors preserve the existing separate delegation and Web admission", () => {
  for (const policy of ["plan-policy.hybrid-v1", "plan-policy.hybrid-todo-v1"] as const) {
    expect(accepts(policy, { name: "spawn_agents", effect: "delegate", source: "builtin" })).toBe(
      false,
    );
    expect(accepts(policy, { name: "web_search", effect: "network", source: "builtin" })).toBe(
      false,
    );
  }
  for (const policy of [
    "plan-policy.hybrid-delegation-v1",
    "plan-policy.hybrid-delegation-todo-v1",
  ] as const) {
    expect(accepts(policy, { name: "spawn_agents", effect: "delegate", source: "builtin" })).toBe(
      true,
    );
    expect(accepts(policy, { name: "web_search", effect: "network", source: "builtin" })).toBe(
      true,
    );
    expect(
      accepts(policy, { name: "unknown_delegate", effect: "delegate", source: "builtin" }),
    ).toBe(false);
  }
});
