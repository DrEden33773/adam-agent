import type { CanonicalRuntimeEvent, SessionRecord } from "@adam-agent/agent";

/** Require an event stream: a Lifecycle-only record is a test failure here. */
export function requireSessionEvent(record: SessionRecord): {
  readonly runId: string;
  readonly event: CanonicalRuntimeEvent;
} {
  if (record.schemaVersion !== 3) return record;
  if (record.record.type !== "runtime_event") {
    throw new TypeError(`Expected a runtime event, received ${record.record.type}.`);
  }
  return record.record;
}
