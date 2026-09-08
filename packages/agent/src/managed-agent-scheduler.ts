import type { ManagedWorkspaceSnapshot } from "@adam-agent/presentation";
import { fleetLimit } from "./fleet-ledger.js";

/** Scheduling selects from durable order. Control owns admission and execution. */
export function selectManagedStarts(
  snapshot: ManagedWorkspaceSnapshot,
  active: ReadonlySet<string>,
  ready: ReadonlySet<string>,
  policy: {
    readonly background: { readonly running: number | "unlimited" };
    readonly reserved: { readonly running: number };
  },
): readonly string[] {
  const remaining = {
    background: fleetLimit(policy.background.running),
    reserved: policy.reserved.running,
  };
  const legacyActive = { background: 0, reserved: 0 };
  for (const thread of snapshot.threads)
    if (active.has(thread.turn.turnId)) {
      const lane = thread.turn.lane ?? "background";
      remaining[lane] -= 1;
      if (thread.turn.envelope?.version !== 3) legacyActive[lane] += 1;
    }
  const envelopes = new Map<string, number>();
  for (const thread of snapshot.threads) {
    const envelope = thread.turn.envelope;
    if (envelope !== undefined && !envelopes.has(envelope.id))
      envelopes.set(
        envelope.id,
        envelope.version === 3 && envelope.concurrency?.mode === "owner"
          ? Infinity
          : envelope.version === 3 && envelope.concurrency?.mode === "limited"
            ? envelope.concurrency.running
            : envelope.running,
      );
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
    const envelope = thread.turn.envelope;
    if (
      envelope?.version !== 3 &&
      legacyActive[lane] >=
        fleetLimit(envelope?.policy[lane].running ?? (lane === "background" ? 4 : 1))
    )
      continue;
    if (thread.turn.envelope !== undefined && (envelopes.get(thread.turn.envelope.id) ?? 0) <= 0)
      continue;
    if (!ready.has(thread.turn.turnId) || active.has(thread.turn.turnId) || remaining[lane] <= 0)
      continue;
    remaining[lane] -= 1;
    if (envelope?.version !== 3) legacyActive[lane] += 1;
    if (thread.turn.envelope !== undefined)
      envelopes.set(thread.turn.envelope.id, (envelopes.get(thread.turn.envelope.id) ?? 0) - 1);
    selected.push(thread.turn.turnId);
  }
  return selected;
}
