import type { ActiveSessionDisplay, PresentationTransientState } from "@adam-agent/presentation";

export function isTuiRunActive(input: {
  readonly parentRun?: ActiveSessionDisplay["parentRun"];
  readonly sessionStatus?: "idle" | "settled" | "interrupted" | undefined;
  readonly cancelSettling: boolean;
  readonly pendingInteractionCount: number;
  readonly transient: PresentationTransientState | null;
}): boolean {
  return (
    (input.parentRun !== undefined
      ? input.parentRun.phase !== "ready"
      : input.sessionStatus === "interrupted") ||
    input.transient !== null ||
    input.pendingInteractionCount > 0 ||
    input.cancelSettling
  );
}
