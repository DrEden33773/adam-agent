import type { ManagedWorkspaceSnapshot } from "@adam-agent/presentation";

/** Scheduling selects from durable order. Control owns admission and execution. */
export function selectManagedStarts(
  snapshot: ManagedWorkspaceSnapshot,
  active: ReadonlySet<string>,
  ready: ReadonlySet<string>,
  policy: {
    readonly background: { readonly running: number };
    readonly reserved: { readonly running: number };
  },
): readonly string[] {
  const remaining = { background: policy.background.running, reserved: policy.reserved.running };
  for (const thread of snapshot.threads)
    if (active.has(thread.turn.turnId)) remaining[thread.turn.lane ?? "background"] -= 1;
  const envelopes = new Map<string, number>();
  for (const thread of snapshot.threads) {
    const envelope = thread.turn.envelope;
    if (envelope !== undefined && !envelopes.has(envelope.id))
      envelopes.set(envelope.id, envelope.running);
  }
  for (const thread of snapshot.threads) {
    const envelope = thread.turn.envelope;
    if (envelope !== undefined && active.has(thread.turn.turnId))
      envelopes.set(envelope.id, (envelopes.get(envelope.id) ?? 0) - 1);
  }
  const selected: string[] = [];
  for (const thread of [...snapshot.threads].sort(
    (a, b) =>
      Number(b.turn.hasStarted === true) - Number(a.turn.hasStarted === true) ||
      (a.turn.admissionSequence ?? 0) - (b.turn.admissionSequence ?? 0),
  )) {
    const lane = thread.turn.lane ?? "background";
    if (thread.turn.envelope !== undefined && (envelopes.get(thread.turn.envelope.id) ?? 0) <= 0)
      continue;
    if (!ready.has(thread.turn.turnId) || active.has(thread.turn.turnId) || remaining[lane] <= 0)
      continue;
    remaining[lane] -= 1;
    if (thread.turn.envelope !== undefined)
      envelopes.set(thread.turn.envelope.id, (envelopes.get(thread.turn.envelope.id) ?? 0) - 1);
    selected.push(thread.turn.turnId);
  }
  return selected;
}
