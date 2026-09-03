import type { PresentationTransientState } from "@adam-agent/presentation";

export function isTuiRunActive(input: {
  readonly cancelSettling: boolean;
  readonly pendingInteractionCount: number;
  readonly transient: PresentationTransientState | null;
}): boolean {
  return input.transient !== null || input.pendingInteractionCount > 0 || input.cancelSettling;
}
