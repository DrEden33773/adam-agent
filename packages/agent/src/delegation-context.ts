import type { ManagedDelegationMessage } from "@adam-agent/presentation";
import { type DelegationContext, managedControlDigest } from "./fleet-ledger.js";
import type { SessionRecord } from "./session-store.js";

export function delegationMessages(records: readonly SessionRecord[]): ManagedDelegationMessage[] {
  return records.flatMap((record) => {
    if (record.schemaVersion !== 3) return [];
    const value = record.record;
    const message =
      value.type === "logical_run_started"
        ? { role: "user" as const, text: value.userMessage }
        : value.type === "runtime_event" && value.event.type === "model_message_completed"
          ? { role: "assistant" as const, text: value.event.text }
          : undefined;
    return message === undefined || Buffer.byteLength(message.text, "utf8") > 16 * 1024
      ? []
      : [{ ...message, sequence: record.sequence, digest: managedControlDigest(record) }];
  });
}

export function resolveDelegationContext(
  context: DelegationContext,
  currentRequest: string,
  messages: readonly ManagedDelegationMessage[],
): string {
  if (context.mode === "task") return "";
  if (context.mode === "current_request") return currentRequest;
  const seen = new Set<number>();
  const selected = context.messages
    .map((reference) => {
      const message = messages.find(
        (message) => message.sequence === reference.sequence && message.digest === reference.digest,
      );
      if (message === undefined || seen.has(message.sequence))
        throw new TypeError("Select available exact parent messages without duplicates.");
      seen.add(message.sequence);
      return `Selected parent ${message.role} message (${message.sequence}):\n${message.text}`;
    })
    .join("\n\n");
  if (Buffer.byteLength(selected, "utf8") > 64 * 1024)
    throw new TypeError("Selected context exceeds 64 KiB.");
  return selected;
}
