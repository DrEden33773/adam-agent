import type { ManagedControlThread } from "@adam-agent/presentation";

/** Handwritten display input for pure view tests; lifecycle behavior uses the real Control fixture. */
export function agentViewThread(index = 1): ManagedControlThread {
  return {
    parentSessionId: "parent",
    threadId: `thread-${index}`,
    handle: `@explore-${index}`,
    displayName: "Explore",
    role: "builtin:explore",
    description: `Evidence ${index}`,
    lifecycle: "open",
    residency: "live",
    actions: ["cancel", "cooperative", "interrupt"],
    turn: {
      turnId: `turn-${index}`,
      attemptId: `attempt-${index}`,
      childSessionId: `child-${index}`,
      phase: "executing",
      label: "Running",
      hasStarted: true,
      waitReason: "none",
      ownerPhase: "claimed",
      lastOutcome: "none",
      recovery: "none",
      health: "healthy",
      configuration: {
        digest: `sha256:${"a".repeat(64)}`,
        parentBranchId: "branch",
        targetId: "fixture-target",
        thinking: "default",
      },
    },
  };
}
